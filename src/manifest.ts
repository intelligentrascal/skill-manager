import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

/** Versioned, repository-owned metadata. It never changes SKILL.md frontmatter. */
export const MANIFEST_VERSION = 1 as const;

export type Provenance = "upstream" | "upstream-edited" | "mine" | "promoted";
export type SecurityReviewState = "unreviewed" | "reviewed" | "blocked";

export interface SkillIdentity {
	upstreamUrl: string;
	subpath: string;
	pinnedRevision: string;
}

export interface SkillVariant {
	agent: string;
	baseRevision: string;
	deployedTo: string;
	conflict?: boolean;
}

export interface SecurityReview {
	state: SecurityReviewState;
	at: string;
}

export interface SkillRecord {
	provenance: Provenance;
	identity?: SkillIdentity;
	variants?: SkillVariant[];
	securityReview?: SecurityReview;
}

export interface SkillManagerManifest {
	version: typeof MANIFEST_VERSION;
	skills: Record<string, SkillRecord>;
}

export class ManifestValidationError extends Error {
	constructor(message: string) {
		super(`Invalid skillmgr.yaml: ${message}`);
		this.name = "ManifestValidationError";
	}
}

type YamlValue = string | boolean | null | YamlObject | YamlValue[];
type YamlObject = { [key: string]: YamlValue };

interface YamlLine {
	indent: number;
	text: string;
	line: number;
}

/**
 * Deliberately small YAML reader for the committed manifest shape: maps, lists,
 * quoted/unquoted scalars, booleans, nulls, and comments. Complex YAML features
 * are rejected instead of silently accepting an ambiguous management record.
 */
function parseYaml(text: string): YamlObject {
	const lines: YamlLine[] = [];
	for (const [index, raw] of text
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/)
		.entries()) {
		if (/\t/.test(raw))
			throw new ManifestValidationError(
				`line ${index + 1}: tabs are not supported`,
			);
		const withoutComment = stripComment(raw);
		if (!withoutComment.trim()) continue;
		const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
		lines.push({ indent, text: withoutComment.trim(), line: index + 1 });
	}
	if (!lines.length) throw new ManifestValidationError("file is empty");
	let cursor = 0;

	const parseBlock = (indent: number): YamlValue => {
		const first = lines[cursor];
		if (!first || first.indent < indent) {
			throw new ManifestValidationError(
				`line ${first?.line ?? "end"}: expected nested value`,
			);
		}
		const list = first.text.startsWith("-");
		const value: YamlValue = list ? [] : {};
		while (cursor < lines.length) {
			const current = lines[cursor];
			if (current.indent < indent) break;
			if (current.indent > indent) {
				throw new ManifestValidationError(
					`line ${current.line}: unexpected indentation`,
				);
			}
			if (list !== current.text.startsWith("-")) {
				throw new ManifestValidationError(
					`line ${current.line}: cannot mix list and map entries`,
				);
			}
			if (list) {
				const item = current.text.slice(1).trim();
				cursor++;
				if (!item) {
					(value as YamlValue[]).push(parseChild(current));
					continue;
				}
				const pair = parsePair(item, current.line);
				if (!pair) (value as YamlValue[]).push(parseScalar(item, current.line));
				else {
					const object: YamlObject = {};
					object[pair.key] = pair.rawValue
						? parseScalar(pair.rawValue, current.line)
						: parseChild(current);
					if (cursor < lines.length && lines[cursor].indent > indent) {
						const extra = parseBlock(lines[cursor].indent);
						if (
							Array.isArray(extra) ||
							typeof extra !== "object" ||
							extra === null
						) {
							throw new ManifestValidationError(
								`line ${current.line}: list item continuation must be a map`,
							);
						}
						Object.assign(object, extra);
					}
					(value as YamlValue[]).push(object);
				}
				continue;
			}
			const pair = parsePair(current.text, current.line);
			if (!pair)
				throw new ManifestValidationError(
					`line ${current.line}: expected key: value`,
				);
			cursor++;
			(value as YamlObject)[pair.key] = pair.rawValue
				? parseScalar(pair.rawValue, current.line)
				: parseChild(current);
		}
		return value;
	};

	const parseChild = (parent: YamlLine): YamlValue => {
		const child = lines[cursor];
		if (!child || child.indent <= parent.indent) {
			throw new ManifestValidationError(
				`line ${parent.line}: expected an indented value`,
			);
		}
		return parseBlock(child.indent);
	};

	const root = parseBlock(lines[0].indent);
	if (Array.isArray(root) || root === null || typeof root !== "object") {
		throw new ManifestValidationError("root must be a map");
	}
	return root;
}

function stripComment(line: string): string {
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if ((char === '"' || char === "'") && (!quote || quote === char))
			quote = quote ? "" : char;
		if (char === "#" && !quote && (i === 0 || /\s/.test(line[i - 1])))
			return line.slice(0, i).trimEnd();
	}
	return line;
}

function parsePair(
	text: string,
	line: number,
): { key: string; rawValue: string } | undefined {
	const match = /^([^:\s][^:]*):(?:\s*(.*))?$/.exec(text);
	if (!match) return undefined;
	const key = match[1].trim();
	if (!key) throw new ManifestValidationError(`line ${line}: empty key`);
	return { key, rawValue: match[2] ?? "" };
}

function parseScalar(raw: string, line: number): string | boolean | null {
	if (
		(raw.startsWith('"') && raw.endsWith('"')) ||
		(raw.startsWith("'") && raw.endsWith("'"))
	) {
		return raw.slice(1, -1);
	}
	if (/^\[|^\{|[>|]$/.test(raw))
		throw new ManifestValidationError(`line ${line}: unsupported YAML scalar`);
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null" || raw === "~") return null;
	return raw;
}

function expectObject(value: YamlValue | undefined, path: string): YamlObject {
	if (!value || Array.isArray(value) || typeof value !== "object")
		throw new ManifestValidationError(`${path} must be a map`);
	return value;
}

function expectString(value: YamlValue | undefined, path: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new ManifestValidationError(`${path} must be a non-empty string`);
	return value;
}

function rejectUnknown(
	object: YamlObject,
	allowed: readonly string[],
	path: string,
): void {
	for (const key of Object.keys(object)) {
		if (!allowed.includes(key))
			throw new ManifestValidationError(
				`${path}.${key} is not a supported field`,
			);
	}
}

/** Parse and validate a skillmgr.yaml document before it influences inventory. */
export function parseManifest(text: string): SkillManagerManifest {
	const root = parseYaml(text);
	rejectUnknown(root, ["version", "skills"], "manifest");
	if (
		root.version !== String(MANIFEST_VERSION) &&
		root.version !== (MANIFEST_VERSION as unknown as string)
	) {
		throw new ManifestValidationError(`version must be ${MANIFEST_VERSION}`);
	}
	const skills = expectObject(root.skills, "skills");
	const records: Record<string, SkillRecord> = {};
	for (const [name, rawRecord] of Object.entries(skills)) {
		if (!name.trim())
			throw new ManifestValidationError("skills cannot contain an empty name");
		const record = expectObject(rawRecord, `skills.${name}`);
		rejectUnknown(
			record,
			["provenance", "identity", "variants", "securityReview"],
			`skills.${name}`,
		);
		const provenance = expectString(
			record.provenance,
			`skills.${name}.provenance`,
		) as Provenance;
		if (
			!["upstream", "upstream-edited", "mine", "promoted"].includes(provenance)
		) {
			throw new ManifestValidationError(`skills.${name}.provenance is invalid`);
		}
		let identity: SkillIdentity | undefined;
		if (record.identity !== undefined) {
			const rawIdentity = expectObject(
				record.identity,
				`skills.${name}.identity`,
			);
			rejectUnknown(
				rawIdentity,
				["upstreamUrl", "subpath", "pinnedRevision"],
				`skills.${name}.identity`,
			);
			identity = {
				upstreamUrl: expectString(
					rawIdentity.upstreamUrl,
					`skills.${name}.identity.upstreamUrl`,
				),
				subpath: expectString(
					rawIdentity.subpath,
					`skills.${name}.identity.subpath`,
				),
				pinnedRevision: expectString(
					rawIdentity.pinnedRevision,
					`skills.${name}.identity.pinnedRevision`,
				),
			};
		}
		if (
			(provenance === "upstream" || provenance === "upstream-edited") &&
			!identity
		) {
			throw new ManifestValidationError(
				`skills.${name}.identity is required for ${provenance}`,
			);
		}
		let variants: SkillVariant[] | undefined;
		if (record.variants !== undefined) {
			if (!Array.isArray(record.variants))
				throw new ManifestValidationError(
					`skills.${name}.variants must be a list`,
				);
			const agents = new Set<string>();
			variants = record.variants.map((rawVariant, index) => {
				const path = `skills.${name}.variants[${index}]`;
				const variant = expectObject(rawVariant, path);
				rejectUnknown(
					variant,
					["agent", "baseRevision", "deployedTo", "conflict"],
					path,
				);
				const agent = expectString(variant.agent, `${path}.agent`);
				if (agents.has(agent))
					throw new ManifestValidationError(
						`${path}.agent duplicates ${agent}`,
					);
				agents.add(agent);
				if (
					variant.conflict !== undefined &&
					typeof variant.conflict !== "boolean"
				) {
					throw new ManifestValidationError(
						`${path}.conflict must be true or false`,
					);
				}
				return {
					agent,
					baseRevision: expectString(
						variant.baseRevision,
						`${path}.baseRevision`,
					),
					deployedTo: expectString(variant.deployedTo, `${path}.deployedTo`),
					...(variant.conflict === undefined
						? {}
						: { conflict: variant.conflict }),
				};
			});
		}
		let securityReview: SecurityReview | undefined;
		if (record.securityReview !== undefined) {
			const review = expectObject(
				record.securityReview,
				`skills.${name}.securityReview`,
			);
			rejectUnknown(review, ["state", "at"], `skills.${name}.securityReview`);
			const state = expectString(
				review.state,
				`skills.${name}.securityReview.state`,
			) as SecurityReviewState;
			if (!["unreviewed", "reviewed", "blocked"].includes(state)) {
				throw new ManifestValidationError(
					`skills.${name}.securityReview.state is invalid`,
				);
			}
			const at = expectString(review.at, `skills.${name}.securityReview.at`);
			if (Number.isNaN(Date.parse(at)))
				throw new ManifestValidationError(
					`skills.${name}.securityReview.at must be an ISO date`,
				);
			securityReview = { state, at };
		}
		records[name] = {
			provenance,
			...(identity ? { identity } : {}),
			...(variants ? { variants } : {}),
			...(securityReview ? { securityReview } : {}),
		};
	}
	return { version: MANIFEST_VERSION, skills: records };
}

/** Read the manifest from disk. Callers choose whether a missing file means no records. */
export async function readManifest(
	path: string,
): Promise<SkillManagerManifest> {
	return parseManifest(await readFile(path, "utf8"));
}

/** Synchronous counterpart for the scanner's synchronous inventory pass. */
export function readManifestSync(path: string): SkillManagerManifest {
	return parseManifest(readFileSync(path, "utf8"));
}
