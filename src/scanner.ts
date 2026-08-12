import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, SCAN_LOCATIONS } from "./config.ts";

interface SkillFile {
	dir: string;
	name: string;
	path: string;
	root: string;
	nested: boolean;
}

interface SkillRecord {
	name: string;
	location: string;
	harnesses: string[];
	upstream?: string;
	description: string;
	tags: string[];
	model: string;
	license: string;
	version: string;
	sha: string;
	path: string;
	mtimeISO: string;
	nested: boolean;
	repoClean?: boolean;
}

interface LocationSummary {
	name: string;
	root: string;
	count: number;
}

interface Stats {
	totalSkills: number;
	totalCopies: number;
	perLocation: Record<string, number>;
	duplicate: number;
	drift: number;
	unique: number;
	oldestMtime: string;
	newestMtime: string;
}

interface Inventory {
	generatedAt: string;
	stats: Stats;
	byName: Record<string, SkillRecord[]>;
	locations: LocationSummary[];
	warnings: string[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "backup"]);

export function walkForSkills(root: string, nested: boolean): SkillFile[] {
	const results: SkillFile[] = [];
	const maxDepth = nested ? 4 : 3;

	function walk(dir: string, depth: number): void {
		if (depth > maxDepth) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				if (entry.name === "SKILL.md") {
					const parentDir = dir;
					const skillName = basename(parentDir);
					results.push({
						dir: parentDir,
						name: skillName,
						path: join(parentDir, entry.name),
						root,
						nested,
					});
				}
				continue;
			}
			if (SKIP_DIRS.has(entry.name)) continue;
			walk(join(dir, entry.name), depth + 1);
		}
	}

	walk(root, 0);
	return results;
}

export function parseFrontmatter(text: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return result;
	const rest = text.slice(text.indexOf("---") + 3);
	const endIdx = rest.indexOf("\n---");
	if (endIdx === -1) return result;
	const block = rest.slice(0, endIdx).trim();
	const lines = block.split(/\r?\n/);
	for (const line of lines) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let value = line.slice(colonIdx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		result[key] = value;
	}
	return result;
}

export function hashFile(path: string): string {
	const content = readFileSync(path);
	return createHash("sha256").update(content).digest("hex");
}

// Find a plausible upstream GitHub repo for a skill by scanning its SKILL.md
// for github.com/<owner>/<repo> references (install lines, source links).
export function isRepoCopyClean(
	repoGitRoot: string,
	skillPath: string,
): boolean {
	const repoRelPath = relative(repoGitRoot, skillPath).replace(/\\/g, "/");
	try {
		const status = execFileSync(
			"git",
			["-C", repoGitRoot, "status", "--porcelain", "--", repoRelPath],
			{ encoding: "utf-8", windowsHide: true },
		);
		return status.length === 0;
	} catch {
		return false;
	}
}

export function extractUpstream(content: string): string | undefined {
	const seen = new Set<string>();
	const re = /github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		const parts = m[0].split("/");
		if (parts.length < 3) continue;
		const owner = parts[1];
		const repo = parts[2].replace(/\.+$/, "");
		if (!owner || !repo) continue;
		const key = owner + "/" + repo;
		if (seen.has(key)) continue;
		seen.add(key);
		return key;
	}
	return undefined;
}

export function scanAll(): Inventory {
	const warnings: string[] = [];
	const allRecords: SkillRecord[] = [];
	const locationCounts: Record<string, number> = {};

	for (const loc of SCAN_LOCATIONS) {
		const nested = (loc as { nested?: boolean }).nested ?? false;
		let skillFiles: SkillFile[];
		try {
			skillFiles = walkForSkills(loc.root, nested);
		} catch (err) {
			warnings.push(`Failed to walk ${loc.root}: ${String(err)}`);
			locationCounts[loc.name] = 0;
			continue;
		}

		for (const sf of skillFiles) {
			let content: string;
			try {
				content = readFileSync(sf.path, "utf-8");
			} catch {
				warnings.push(`Failed to read ${sf.path}`);
				continue;
			}

			let frontmatter: Record<string, unknown>;
			try {
				frontmatter = parseFrontmatter(content);
			} catch {
				frontmatter = {};
			}

			let sha: string;
			try {
				sha = hashFile(sf.path);
			} catch {
				sha = "";
			}

			let mtimeISO = "";
			try {
				mtimeISO = statSync(sf.path).mtime.toISOString();
			} catch {
				// keep empty
			}

			const description = String(frontmatter["description"] ?? "");
			const tagsStr = String(frontmatter["tags"] ?? "");
			const tags = tagsStr ? tagsStr.split(/[\s,]+/).filter(Boolean) : [];
			const model = String(frontmatter["model"] ?? "");
			const license = String(frontmatter["license"] ?? "");
			const version = String(frontmatter["version"] ?? "");

			const record: SkillRecord = {
				name: sf.name,
				location: loc.name,
				harnesses: [], // filled after grouping
				upstream: extractUpstream(content),
				description,
				tags,
				model,
				license,
				version,
				sha,
				path: sf.path,
				mtimeISO,
				nested,
				repoClean: undefined,
			};

			allRecords.push(record);
		}
		locationCounts[loc.name] = skillFiles.length;
	}

	// Group by name
	const byName: Record<string, SkillRecord[]> = {};
	for (const rec of allRecords) {
		if (!byName[rec.name]) byName[rec.name] = [];
		byName[rec.name].push(rec);
	}

	// Fill harnesses for each record (which locations expose this skill name)
	for (const name of Object.keys(byName)) {
		const copies = byName[name];
		const harnessLocations = copies.map((r) => r.location);
		for (const rec of copies) {
			rec.harnesses = harnessLocations;
		}
	}

	// Compute status per name and repoClean for repo copies
	const repoGitRoot = repoRoot();

	for (const name of Object.keys(byName)) {
		const copies = byName[name];

		// repoClean for repo copies
		for (const rec of copies) {
			if (rec.location === "repo" && rec.nested) {
				rec.repoClean = isRepoCopyClean(repoGitRoot, rec.path);
			}
		}
	}

	// Stats
	const totalSkills = Object.keys(byName).length;
	const totalCopies = allRecords.length;

	let duplicateCount = 0;
	let driftCount = 0;
	let uniqueCount = 0;
	for (const name of Object.keys(byName)) {
		const copies = byName[name];
		if (copies.length === 1) {
			uniqueCount++;
		} else {
			const shas = new Set(copies.map((r) => r.sha));
			if (shas.size === 1) {
				duplicateCount++;
			} else {
				driftCount++;
			}
		}
	}

	let oldestMtime = "";
	let newestMtime = "";
	for (const rec of allRecords) {
		if (!rec.mtimeISO) continue;
		if (!oldestMtime || rec.mtimeISO < oldestMtime) oldestMtime = rec.mtimeISO;
		if (!newestMtime || rec.mtimeISO > newestMtime) newestMtime = rec.mtimeISO;
	}

	const stats: Stats = {
		totalSkills,
		totalCopies,
		perLocation: locationCounts,
		duplicate: duplicateCount,
		drift: driftCount,
		unique: uniqueCount,
		oldestMtime,
		newestMtime,
	};

	const locations: LocationSummary[] = SCAN_LOCATIONS.map((loc) => ({
		name: loc.name,
		root: loc.root,
		count: locationCounts[loc.name] ?? 0,
	}));

	return {
		generatedAt: new Date().toISOString(),
		stats,
		byName,
		locations,
		warnings,
	};
}

// Run as main only when executed directly
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const inventory = scanAll();
	console.log(JSON.stringify(inventory, null, 2));
}
