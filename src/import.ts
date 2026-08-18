// Canonical origin import: promote a discovered copy into the managed
// agent-skills repository as the initial canonical skill, record its origin
// evidence, and commit + push the result directly to agent-skills/main.
//
// Safety contract (mirrors the sync flow):
// - Preview is read-only: it validates the origin, derives the canonical
//   content, hashes it, and reports exactly what would be written. Nothing
//   changes on disk.
// - Assign re-verifies the approved content hash before writing anything, so a
//   source that changed after preview is refused rather than silently imported.
// - After writing, the canonical file and the manifest are read back and
//   verified before the commit is created.
// - A rejected push never triggers a rebase, reset, or conflict resolution: the
//   verified local commit stays on the branch, inspectable and retryable.
// - A client-supplied sourcePath is accepted only when it resolves to a
//   SKILL.md the scanner actually discovers inside an approved scan location
//   (never an arbitrary path such as a key file).
//
// Honesty: the origin evidence written here comes only from validated inputs
// (this module never invents GitHub owner/repo/stars). Private and local origins
// are recorded without pinned revisions or verification timestamps.

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SCAN_LOCATIONS, type ScanLocation } from "./config.ts";
import { parseFrontmatter, walkForSkills } from "./scanner.ts";
import {
	newManifestWithEntry,
	parseManifest,
	upsertSkillEntry,
	type SkillIdentity,
	type SkillManagerManifest,
	type SkillRecord,
} from "./manifest.ts";
import {
	provenanceForOrigin,
	reassignOrigin,
	validateOriginInput,
	type OriginAssignment,
	type OriginInput,
} from "./origin.ts";

const execFile = promisify(execFileCallback);

export class ImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ImportError";
	}
}

function sha(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export interface ImportPreview {
	skillName: string;
	category: string;
	targetPath: string;
	repoRelativePath: string;
	alreadyManaged: boolean;
	contentSha: string;
	contentBytes: number;
	content: string;
	provenance: "upstream" | "mine";
	/** Verified skill name for a github origin (frontmatter `name` first,
	 * owner/repo-derived fallback). The manifest key is never renamed. */
	canonicalName?: string;
	identity?: SkillIdentity;
	origin: OriginAssignment;
	pinnedRevision?: string;
}

export interface AssignOriginRequest {
	skillName: string;
	category?: string;
	origin: OriginInput;
	/** Approved content hash from the preview (re-verified before any write). */
	expectedContentSha: string;
	/** GitHub only: the revision pinned at preview time. */
	pinnedRevision?: string;
	/** Private/local: the discovered copy to import (re-read and re-hashed). */
	sourcePath?: string;
}

export interface AssignOriginResult {
	skillName: string;
	category: string;
	targetPath: string;
	contentSha: string;
	provenance: "upstream" | "mine";
	origin: OriginAssignment;
	committed: boolean;
	commitSha?: string;
	pushed: boolean;
	pushError?: string;
	retryable: boolean;
}

interface ResolvedContent {
	content: string;
	buffer: Buffer;
	sha: string;
	bytes: number;
}

interface ResolvedPlan {
	assignment: OriginAssignment;
	resolved: ResolvedContent;
	canonicalName?: string;
	identity?: SkillIdentity;
	pinnedRevision?: string;
}

/** Network boundary for GitHub origins. Defaults to a real git implementation. */
export interface GithubFetcher {
	pinRevision(cloneUrl: string): Promise<string>;
	fetchSkill(
		cloneUrl: string,
		revision: string,
		subpath: string,
	): Promise<string>;
}

export class GitGithubFetcher implements GithubFetcher {
	async pinRevision(cloneUrl: string): Promise<string> {
		const { stdout } = await execFile("git", ["ls-remote", cloneUrl, "HEAD"]);
		const revision = String(stdout).trim().split(/\s+/)[0];
		if (!revision) {
			throw new ImportError(`Unable to resolve HEAD for ${cloneUrl}`);
		}
		return revision;
	}

	async fetchSkill(
		cloneUrl: string,
		revision: string,
		subpath: string,
	): Promise<string> {
		const checkout = mkdtempSync(join(tmpdir(), "skill-manager-origin-"));
		try {
			// --branch supports tags and named refs; a raw SHA is fetched explicitly.
			try {
				await execFile("git", [
					"clone", "--depth", "1", "--branch", revision, cloneUrl, checkout,
				]);
			} catch {
				rmSync(checkout, { recursive: true, force: true });
				await execFile("git", ["clone", "--depth", "1", cloneUrl, checkout]);
				await execFile(
					"git",
					["fetch", "--depth", "1", "origin", revision],
					{ cwd: checkout },
				);
				await execFile("git", ["checkout", "--detach", "FETCH_HEAD"], {
					cwd: checkout,
				});
			}
			const skillPath = join(checkout, subpath, "SKILL.md");
			if (!existsSync(skillPath)) {
				throw new ImportError(
					`SKILL.md not found at subpath '${subpath}' in ${cloneUrl}@${revision}`,
				);
			}
			return readFileSync(skillPath, "utf8");
		} catch (error) {
			if (error instanceof ImportError) throw error;
			throw new ImportError(
				`Unable to fetch ${cloneUrl}@${revision} subpath '${subpath}': ${
					error instanceof Error ? error.message : "unknown git error"
				}`,
			);
		} finally {
			rmSync(checkout, { recursive: true, force: true });
		}
	}
}

function assertSafeSegment(value: string, label: string): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) throw new ImportError(`${label} is required`);
	if (/[/\\]/.test(trimmed) || trimmed === "." || trimmed === "..") {
		throw new ImportError(`${label} must be a single path segment`);
	}
	if (/[\r\n:]/.test(trimmed)) {
		throw new ImportError(`${label} contains unsupported characters`);
	}
	return trimmed;
}

function findRepoSkillPath(repoRoot: string, name: string): string | null {
	const files = walkForSkills(join(repoRoot, "skills"), true);
	const found = files.find((file) => file.name === name);
	return found?.path ?? null;
}

function readExistingManifest(repoRoot: string): {
	text: string | null;
	manifest: SkillManagerManifest | null;
} {
	const path = join(repoRoot, "skillmgr.yaml");
	if (!existsSync(path)) return { text: null, manifest: null };
	const text = readFileSync(path, "utf8");
	return { text, manifest: parseManifest(text) };
}

/**
 * The verified skill name for a GitHub origin. The imported SKILL.md frontmatter
 * `name` is the authoritative skill name; when it is absent or empty, derive one
 * from the verified owner/repo facts (the repository name) so the record always
 * carries a name backed by the verified GitHub origin.
 */
export function verifiedSkillName(
	content: string,
	ref: { owner: string; repo: string },
): string {
	const frontmatter = parseFrontmatter(content);
	const name = frontmatter["name"];
	if (typeof name === "string" && name.trim() !== "") return name.trim();
	return ref.repo;
}

export class OriginImportService {
	private readonly fetcher: GithubFetcher;
	private readonly scanLocations: ScanLocation[];

	constructor(
		fetcher: GithubFetcher = new GitGithubFetcher(),
		scanLocations: ScanLocation[] = SCAN_LOCATIONS,
	) {
		this.fetcher = fetcher;
		this.scanLocations = scanLocations;
	}

	/** Read-only preview: nothing is written, no commit or push occurs. */
	async preview(
		repoRoot: string,
		request: AssignOriginRequest,
	): Promise<ImportPreview> {
		const skillName = assertSafeSegment(request.skillName, "skill name");
		const plan = await this.resolvePlan(
			request,
			skillName,
			repoRoot,
			new Date().toISOString(),
		);
		return this.describe(request, skillName, repoRoot, plan);
	}

	/** Validate, import, commit, and push. Never rewrites a conflicting canonical copy. */
	async assign(
		repoRoot: string,
		request: AssignOriginRequest,
	): Promise<AssignOriginResult> {
		const skillName = assertSafeSegment(request.skillName, "skill name");
		if (!request.expectedContentSha) {
			throw new ImportError(
				"expectedContentSha is required (from the approved preview)",
			);
		}
		const plan = await this.resolvePlan(
			request,
			skillName,
			repoRoot,
			new Date().toISOString(),
		);
		if (request.expectedContentSha !== plan.resolved.sha) {
			throw new ImportError(
				"The selected source changed since preview. Preview the import again.",
			);
		}

		const preview = this.describe(request, skillName, repoRoot, plan);
		const existingPath = findRepoSkillPath(repoRoot, skillName);
		const targetPath =
			existingPath ??
			join(
				repoRoot,
				"skills",
				assertSafeSegment(request.category ?? preview.category, "category"),
				skillName,
				"SKILL.md",
			);

		// Write the canonical content unless an identical copy already exists.
		if (existingPath) {
			const currentSha = sha(readFileSync(existingPath));
			if (currentSha !== plan.resolved.sha) {
				throw new ImportError(
					`A canonical copy already exists at ${existingPath} with different content. Resolve the conflict manually before assigning an origin.`,
				);
			}
		} else {
			mkdirSync(dirname(targetPath), { recursive: true });
			writeFileSync(targetPath, plan.resolved.buffer);
			if (sha(readFileSync(targetPath)) !== plan.resolved.sha) {
				throw new ImportError("Canonical content write failed verification.");
			}
		}

		// Record the origin (append-only) and write the manifest.
		const { text: manifestText, manifest } = readExistingManifest(repoRoot);
		const existingRecord = manifest?.skills[skillName];
		const originRecord = reassignOrigin(
			existingRecord?.origin,
			plan.assignment,
		);
		const record: SkillRecord = {
			provenance: provenanceForOrigin(plan.assignment),
			// The verified github skill name is recorded as canonicalName; the
			// record key stays the stable local name so cross-references and
			// provenance history are never broken. A non-github reassignment
			// keeps a previously verified name rather than silently dropping it.
			...(plan.canonicalName ?? existingRecord?.canonicalName
				? { canonicalName: plan.canonicalName ?? existingRecord?.canonicalName }
				: {}),
			...(plan.identity ? { identity: plan.identity } : {}),
			origin: originRecord,
			...(existingRecord?.variants ? { variants: existingRecord.variants } : {}),
			...(existingRecord?.securityReview
				? { securityReview: existingRecord.securityReview }
				: {}),
		};
		const manifestPath = join(repoRoot, "skillmgr.yaml");
		const nextManifestText =
			manifestText === null
				? newManifestWithEntry(skillName, record)
				: upsertSkillEntry(manifestText, skillName, record);
		writeFileSync(manifestPath, nextManifestText, "utf8");

		// Verify the manifest round-trips before committing.
		const verified = parseManifest(readFileSync(manifestPath, "utf8"));
		const verifiedRecord = verified.skills[skillName];
		if (
			!verifiedRecord?.origin ||
			verifiedRecord.origin.current.type !== plan.assignment.type
		) {
			throw new ImportError("Manifest verification failed after write.");
		}

		const repoRelativePath = relative(repoRoot, targetPath).replace(/\\/g, "/");
		const commitSha = await this.commit(repoRoot, [
			repoRelativePath,
			"skillmgr.yaml",
		], skillName);
		const push = await this.push(repoRoot);

		return {
			skillName,
			category: preview.category,
			targetPath,
			contentSha: plan.resolved.sha,
			provenance: provenanceForOrigin(plan.assignment),
			origin: plan.assignment,
			committed: true,
			commitSha,
			pushed: push.pushed,
			pushError: push.error,
			retryable: !push.pushed,
		};
	}

	private async resolvePlan(
		request: AssignOriginRequest,
		skillName: string,
		repoRoot: string,
		at: string,
	): Promise<ResolvedPlan> {
		const validation = validateOriginInput(request.origin, at);
		if (!validation.ok || !validation.assignment) {
			throw new ImportError(
				`Invalid origin assignment: ${validation.errors.join("; ")}`,
			);
		}
		const assignment = validation.assignment;
		let resolved: ResolvedContent;
		let canonicalName: string | undefined;
		let identity: SkillIdentity | undefined;
		let pinnedRevision: string | undefined;
		if (validation.github) {
			const { ref, subpath } = validation.github;
			pinnedRevision =
				request.pinnedRevision ?? (await this.fetcher.pinRevision(ref.cloneUrl));
			const content = await this.fetcher.fetchSkill(
				ref.cloneUrl,
				pinnedRevision,
				subpath,
			);
			resolved = this.bufferContent(content);
			canonicalName = verifiedSkillName(content, ref);
			identity = {
				upstreamUrl: ref.cloneUrl,
				subpath,
				pinnedRevision,
			};
			assignment.verifiedAt = at;
		} else {
			resolved = this.resolveLocalContent(request, skillName, repoRoot);
		}
		return { assignment, resolved, canonicalName, identity, pinnedRevision };
	}

	private describe(
		request: AssignOriginRequest,
		skillName: string,
		repoRoot: string,
		plan: ResolvedPlan,
	): ImportPreview {
		const existingPath = findRepoSkillPath(repoRoot, skillName);
		const category = existingPath
			? relative(join(repoRoot, "skills"), dirname(dirname(existingPath)))
			: assertSafeSegment(request.category ?? "misc", "category");
		const targetPath =
			existingPath ??
			join(repoRoot, "skills", category, skillName, "SKILL.md");
		return {
			skillName,
			category,
			targetPath,
			repoRelativePath: relative(repoRoot, targetPath).replace(/\\/g, "/"),
			alreadyManaged: existingPath !== null,
			contentSha: plan.resolved.sha,
			contentBytes: plan.resolved.bytes,
			content: plan.resolved.content,
			provenance: provenanceForOrigin(plan.assignment),
			...(plan.canonicalName ? { canonicalName: plan.canonicalName } : {}),
			identity: plan.identity,
			origin: plan.assignment,
			pinnedRevision: plan.pinnedRevision,
		};
	}

	private bufferContent(content: string): ResolvedContent {
		const buffer = Buffer.from(content, "utf8");
		return {
			content,
			buffer,
			sha: sha(buffer),
			bytes: buffer.length,
		};
	}

	private resolveLocalContent(
		request: AssignOriginRequest,
		skillName: string,
		repoRoot: string,
	): ResolvedContent {
		const path =
			request.sourcePath !== undefined && request.sourcePath.trim() !== ""
				? this.resolveDiscoveredSource(request.sourcePath)
				: findRepoSkillPath(repoRoot, skillName);
		if (!path) {
			throw new ImportError(
				`No content source for '${skillName}'. Provide a sourcePath (discovered copy) or a public GitHub origin.`,
			);
		}
		const buffer = readFileSync(path);
		return {
			content: buffer.toString("utf8"),
			buffer,
			sha: sha(buffer),
			bytes: buffer.length,
		};
	}

	/**
	 * A client-supplied sourcePath is accepted ONLY when it resolves to a
	 * SKILL.md the scanner actually discovers inside an approved scan location.
	 * This closes the arbitrary-file-read/exfiltration path: a sourcePath such
	 * as ~/.ssh/id_rsa (or any non-SKILL.md, out-of-location, or symlinked
	 * escape) is rejected before a single byte is read.
	 */
	private resolveDiscoveredSource(sourcePath: string): string {
		const absolute = resolve(sourcePath.trim());
		if (basename(absolute) !== "SKILL.md") {
			throw new ImportError("sourcePath must point at a SKILL.md file");
		}
		let real: string;
		try {
			real = realpathSync(absolute);
		} catch {
			throw new ImportError(
				`sourcePath does not resolve to an existing file: ${sourcePath}`,
			);
		}
		// Reject symlinks that escape an approved location before trusting the path.
		if (!this.isInsideApprovedLocation(real)) {
			throw new ImportError(
				"sourcePath must be inside an approved scan location",
			);
		}
		if (!this.discoveredCopies().has(real)) {
			throw new ImportError(
				"sourcePath must be a discovered SKILL.md copy, not an arbitrary file",
			);
		}
		return real;
	}

	private isInsideApprovedLocation(real: string): boolean {
		for (const loc of this.scanLocations) {
			try {
				const rootReal = realpathSync(loc.root);
				const rel = relative(rootReal, real);
				if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
					return true;
				}
			} catch {
				// root does not exist, so it cannot contain the candidate
			}
		}
		return false;
	}

	/** Real paths of every SKILL.md the scanner discovers across approved locations. */
	private discoveredCopies(): Set<string> {
		const found = new Set<string>();
		for (const loc of this.scanLocations) {
			for (const file of walkForSkills(loc.root, loc.nested ?? false)) {
				try {
					found.add(realpathSync(file.path));
				} catch {
					// unreadable or vanished mid-scan - never a valid source
				}
			}
		}
		return found;
	}

	private async commit(
		repoRoot: string,
		files: string[],
		skillName: string,
	): Promise<string> {
		try {
			await execFile("git", ["-C", repoRoot, "add", "--", ...files]);
			await execFile("git", [
				"-C",
				repoRoot,
				"commit",
				"-m",
				`skillmgr: assign origin and canonical content for ${skillName}`,
			]);
			const { stdout } = await execFile("git", [
				"-C",
				repoRoot,
				"rev-parse",
				"HEAD",
			]);
			return String(stdout).trim();
		} catch (error) {
			throw new ImportError(
				`Commit failed: ${error instanceof Error ? error.message : "unknown git error"}`,
			);
		}
	}

	private async push(
		repoRoot: string,
	): Promise<{ pushed: boolean; error?: string }> {
		try {
			// Push the verified commit explicitly to agent-skills/main, never the
			// ambiguous same-named branch that a bare "HEAD" implies on a
			// detached HEAD or a non-main branch.
			await execFile("git", [
				"-C",
				repoRoot,
				"push",
				"origin",
				"HEAD:main",
			]);
			return { pushed: true };
		} catch (error) {
			return {
				pushed: false,
				error: error instanceof Error ? error.message : "unknown git error",
			};
		}
	}
}
