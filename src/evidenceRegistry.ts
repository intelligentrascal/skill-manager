// Agent evidence registry: the versioned, evidence-backed capability profiles
// that describe what Pi, Claude, OpenCode, and Codex require for safe
// adaptation (ticket #3 vertical slice).
//
// This file owns the SCHEMA + the SEED active registry. It does NOT build
// adaptation variants (#5/#6/#7) or the origin-led workspace (#4).
//
// Honesty rules (mirroring compat.ts / discovery.ts):
// - every behavior claim carries an evidence level (documented | inferred |
//   unknown). Nothing is marked documented without a source we can point to.
// - unsupported/unknown facts stay unknown: codex and opencode have no
//   verified official source here, so their profiles are inferred and carry
//   no fetchable source (the monthly check blocks them instead of guessing).
// - the ACTIVE registry is the only thing an approval may change. The
//   hardcoded adaptation rules in compat.ts / variant.ts are NOT touched by
//   any code path in this slice (AC3: registry changes never affect active
//   adaptation rules until explicitly approved).

import type { AgentId } from "./compat.ts";

export const EVIDENCE_REGISTRY_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_REGISTRY_VERSION = "1.0.0";

export type EvidenceLevel = "documented" | "inferred" | "unknown";
export type SourceKind = "specification" | "documentation" | "package";
export type Treatment =
	| "honors"
	| "ignores"
	| "breaks"
	| "requires"
	| "silent";

export interface EvidenceSource {
	/** Official source locator. http(s) URLs are fetchable by the monthly check; other forms (e.g. a pinned npm package) are recorded but not re-fetched. */
	url: string;
	kind: SourceKind;
	/** Verbatim excerpt supporting this profile's claims. */
	excerpt: string;
	/** ISO timestamp of when the excerpt/content was captured. */
	observedAt: string;
	/** sha256 of the source content at capture time. Empty when never captured (first check establishes the baseline). */
	contentHash: string;
	/** true when the monthly check may fetch this URL; false = blocked/unknown (never guessed). */
	fetchable: boolean;
}

export interface BehaviorClaim {
	field: string;
	treatment: Treatment;
	note: string;
	evidence: EvidenceLevel;
}

export interface AdaptationConstraint {
	rule: string;
	evidence: EvidenceLevel;
	/** 1-based indexes into sources[] that support this constraint (when known). */
	sourceRefs?: number[];
}

export interface AgentEvidenceProfile {
	agent: AgentId;
	name: string;
	/** runtime version the facts were validated against. */
	observedVersion: string;
	/** when the profile was last validated. */
	observedAt: string;
	evidence: EvidenceLevel;
	sources: EvidenceSource[];
	behavior: BehaviorClaim[];
	constraints: AdaptationConstraint[];
	notes: string[];
}

export interface EvidenceRegistry {
	schemaVersion: typeof EVIDENCE_REGISTRY_SCHEMA_VERSION;
	registryVersion: string;
	generatedAt: string;
	profiles: Record<AgentId, AgentEvidenceProfile>;
}

export class RegistryValidationError extends Error {
	constructor(message: string) {
		super(`Invalid agent evidence registry: ${message}`);
		this.name = "RegistryValidationError";
	}
}

const AGENTS: AgentId[] = ["pi", "claude", "codex", "opencode"];
const EVIDENCE_LEVELS: EvidenceLevel[] = [
	"documented",
	"inferred",
	"unknown",
];
const TREATMENTS: Treatment[] = [
	"honors",
	"ignores",
	"breaks",
	"requires",
	"silent",
];
const SOURCE_KINDS: SourceKind[] = [
	"specification",
	"documentation",
	"package",
];

function expectObject(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RegistryValidationError(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}

function expectString(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new RegistryValidationError(`${path} must be a non-empty string`);
	}
	return value;
}

function expectArray(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new RegistryValidationError(`${path} must be an array`);
	}
	return value;
}

function expectEnum<T extends string>(
	value: unknown,
	path: string,
	allowed: readonly T[],
): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new RegistryValidationError(
			`${path} must be one of: ${allowed.join(", ")}`,
		);
	}
	return value as T;
}

function expectIsoDate(value: unknown, path: string): string {
	const s = expectString(value, path);
	if (Number.isNaN(Date.parse(s))) {
		throw new RegistryValidationError(`${path} must be an ISO date`);
	}
	return s;
}

/**
 * Strict structural validation before a registry document may influence
 * anything. Mirrors the manifest's strict-validation posture: reject unknown
 * keys and wrong shapes instead of silently accepting an ambiguous record.
 */
export function validateRegistry(value: unknown): asserts value is EvidenceRegistry {
	const root = expectObject(value, "registry");
	if (root.schemaVersion !== EVIDENCE_REGISTRY_SCHEMA_VERSION) {
		throw new RegistryValidationError(
			`registry.schemaVersion must be ${EVIDENCE_REGISTRY_SCHEMA_VERSION}`,
		);
	}
	expectString(root.registryVersion, "registry.registryVersion");
	expectIsoDate(root.generatedAt, "registry.generatedAt");
	const profiles = expectObject(root.profiles, "registry.profiles");
	for (const agent of AGENTS) {
		if (!(agent in profiles)) {
			throw new RegistryValidationError(`registry.profiles.${agent} is missing`);
		}
	}
	for (const [key, rawProfile] of Object.entries(profiles)) {
		const path = `registry.profiles.${key}`;
		if (!AGENTS.includes(key as AgentId)) {
			throw new RegistryValidationError(`${path} is not a known agent`);
		}
		const profile = expectObject(rawProfile, path);
		expectString(profile.agent, `${path}.agent`);
		if (profile.agent !== key) {
			throw new RegistryValidationError(`${path}.agent must match its key`);
		}
		expectString(profile.name, `${path}.name`);
		expectString(profile.observedVersion, `${path}.observedVersion`);
		expectIsoDate(profile.observedAt, `${path}.observedAt`);
		expectEnum(profile.evidence, `${path}.evidence`, EVIDENCE_LEVELS);

		const sources = expectArray(profile.sources, `${path}.sources`);
		sources.forEach((rawSource, index) => {
			const sp = `${path}.sources[${index}]`;
			const source = expectObject(rawSource, sp);
			expectString(source.url, `${sp}.url`);
			expectEnum(source.kind, `${sp}.kind`, SOURCE_KINDS);
			expectString(source.excerpt, `${sp}.excerpt`);
			expectIsoDate(source.observedAt, `${sp}.observedAt`);
			if (typeof source.contentHash !== "string") {
				throw new RegistryValidationError(`${sp}.contentHash must be a string`);
			}
			if (typeof source.fetchable !== "boolean") {
				throw new RegistryValidationError(`${sp}.fetchable must be a boolean`);
			}
		});

		const behavior = expectArray(profile.behavior, `${path}.behavior`);
		behavior.forEach((rawClaim, index) => {
			const cp = `${path}.behavior[${index}]`;
			const claim = expectObject(rawClaim, cp);
			expectString(claim.field, `${cp}.field`);
			expectEnum(claim.treatment, `${cp}.treatment`, TREATMENTS);
			expectString(claim.note, `${cp}.note`);
			expectEnum(claim.evidence, `${cp}.evidence`, EVIDENCE_LEVELS);
		});

		const constraints = expectArray(profile.constraints, `${path}.constraints`);
		constraints.forEach((rawConstraint, index) => {
			const cp = `${path}.constraints[${index}]`;
			const constraint = expectObject(rawConstraint, cp);
			expectString(constraint.rule, `${cp}.rule`);
			expectEnum(constraint.evidence, `${cp}.evidence`, EVIDENCE_LEVELS);
			if (constraint.sourceRefs !== undefined) {
				const refs = expectArray(constraint.sourceRefs, `${cp}.sourceRefs`);
				for (const ref of refs) {
					if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 1) {
						throw new RegistryValidationError(
							`${cp}.sourceRefs must be 1-based integers`,
						);
					}
				}
			}
		});

		const notes = expectArray(profile.notes, `${path}.notes`);
		for (const note of notes) {
			expectString(note, `${path}.notes[]`);
		}
	}
}

/** Bump the patch segment of a semver-like registry version ("1.0.0" -> "1.0.1"). */
export function bumpRegistryVersion(version: string): string {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) {
		throw new RegistryValidationError(`registryVersion '${version}' is not x.y.z`);
	}
	return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

// ---------------------------------------------------------------------------
// Seed registry: the initial active registry. Populated only with evidence we
// can point to. Pi and Claude are documented (the Agent Skills standard is the
// reference spec; pi's bundled 0.84.1 docs were read on 2026-08-12 and are
// content-addressed). Codex and OpenCode are inferred with no fetchable source.
// ---------------------------------------------------------------------------

const PI_DOCS_HASH =
	"de38956dcdb3f060b62a891c23b5c0facc568d26039cd0addd6d5adfbed2762f";
const OBSERVED_AT = "2026-08-12T00:00:00.000Z";

const AGENTSKILLS_SPEC: EvidenceSource = {
	url: "https://agentskills.io/specification",
	kind: "specification",
	excerpt:
		"Pi implements the Agent Skills standard, warning about most violations but remaining lenient.",
	observedAt: OBSERVED_AT,
	contentHash: "", // first check establishes the baseline
	fetchable: true,
};

const PI_BUNDLED_DOCS: EvidenceSource = {
	url: "npm:@earendil-works/pi-coding-agent@0.84.1#docs/skills.md",
	kind: "documentation",
	excerpt:
		"allowed-tools: Space-delimited list of pre-approved tools (experimental). disable-model-invocation: When true, skill is hidden from system prompt. Users must use /skill:name. Exception: Skills with missing description are not loaded. Unknown frontmatter fields are ignored.",
	observedAt: OBSERVED_AT,
	contentHash: PI_DOCS_HASH,
	fetchable: false, // pinned npm package; not re-fetchable from a public URL
};

const CLAUDE_INVOCATION = [
	"user-invocable",
	"argument-hint",
	"arguments",
	"context",
];

function behavior(
	field: string,
	treatment: Treatment,
	note: string,
	evidence: EvidenceLevel,
): BehaviorClaim {
	return { field, treatment, note, evidence };
}

const SEED_PROFILES: Record<AgentId, AgentEvidenceProfile> = {
	pi: {
		agent: "pi",
		name: "Pi",
		observedVersion: "0.84.1",
		observedAt: OBSERVED_AT,
		evidence: "documented",
		sources: [AGENTSKILLS_SPEC, PI_BUNDLED_DOCS],
		behavior: [
			behavior("name", "honors", "Max 64 chars; lowercase a-z, 0-9, hyphens. Pi does not require matching the parent directory.", "documented"),
			behavior("description", "requires", "Skills with missing description are not loaded.", "documented"),
			behavior("license", "honors", "Recorded from frontmatter.", "documented"),
			behavior("compatibility", "honors", "Max 500 chars; environment requirements.", "documented"),
			behavior("metadata", "honors", "Arbitrary key-value mapping.", "documented"),
			behavior("allowed-tools", "honors", "Space-delimited list of pre-approved tools (experimental).", "documented"),
			behavior("disable-model-invocation", "honors", "When true, skill is hidden from system prompt; /skill:name still works.", "documented"),
			behavior("unknown-fields", "silent", "Unknown frontmatter fields are ignored.", "documented"),
			behavior("user-invocable", "ignores", "Claude invocation vocabulary has no equivalent on pi; intent is lost.", "inferred"),
			behavior("argument-hint", "ignores", "Claude invocation vocabulary has no equivalent on pi; intent is lost.", "inferred"),
			behavior("arguments", "ignores", "Claude invocation vocabulary has no equivalent on pi; intent is lost.", "inferred"),
			behavior("context", "ignores", "Claude invocation vocabulary has no equivalent on pi; intent is lost.", "inferred"),
		],
		constraints: [
			{ rule: "Keep allowed-tools and disable-model-invocation during adaptation - pi honors them.", evidence: "documented", sourceRefs: [2] },
			{ rule: "Ensure a description is present - a skill without one is not loaded.", evidence: "documented", sourceRefs: [2] },
			{ rule: "Claude invocation fields (user-invocable, argument-hint, arguments, context) do not carry over to pi - fold their intent into the description instead.", evidence: "inferred" },
		],
		notes: [
			"Name collisions (same name from different locations) warn and keep the first skill found.",
			"Loads from ~/.pi/agent/skills, ~/.agents/skills, trusted project .pi/skills and .agents/skills, package skills, settings.skills[], and --skill paths.",
			"RuntimeVersion pinned to the installed package; discovery facts live in discoveryProfiles.ts.",
		],
	},
	claude: {
		agent: "claude",
		name: "Claude",
		observedVersion: "2.x",
		observedAt: OBSERVED_AT,
		evidence: "documented",
		sources: [AGENTSKILLS_SPEC],
		behavior: [
			behavior("name", "honors", "Per the Agent Skills specification.", "documented"),
			behavior("description", "requires", "Missing description prevents reliable discovery.", "documented"),
			behavior("license", "honors", "Per the Agent Skills specification.", "documented"),
			behavior("compatibility", "honors", "Per the Agent Skills specification.", "documented"),
			behavior("metadata", "honors", "Per the Agent Skills specification.", "documented"),
			behavior("allowed-tools", "honors", "Hard tool restriction on claude.", "documented"),
			behavior("disable-model-invocation", "honors", "Hides the skill from automatic invocation.", "documented"),
			behavior("user-invocable", "honors", "Claude invocation vocabulary; enables interactive invocation.", "inferred"),
			behavior("argument-hint", "honors", "Claude invocation vocabulary; guides argument usage.", "inferred"),
			behavior("arguments", "honors", "Claude invocation vocabulary; structured arguments.", "inferred"),
			behavior("context", "honors", "Claude invocation vocabulary; invocation context.", "inferred"),
		],
		constraints: [
			{ rule: "Claude honors the invocation vocabulary - do not remove these fields from a shared SKILL.md.", evidence: "inferred" },
			{ rule: "allowed-tools is a hard restriction on claude; body text is advisory everywhere.", evidence: "inferred" },
		],
		notes: [
			"Claude Code is the reference implementation of the Agent Skills standard.",
			"The invocation vocabulary (user-invocable, argument-hint, arguments, context) is carried from the existing compatibility knowledge base; its authoritative source URL is unverified here, so those claims are inferred.",
		],
	},
	codex: {
		agent: "codex",
		name: "Codex",
		observedVersion: "unknown",
		observedAt: OBSERVED_AT,
		evidence: "inferred",
		sources: [],
		behavior: [
			behavior("name", "honors", "Core Agent Skills field.", "inferred"),
			behavior("description", "requires", "Discovery suffers without it.", "inferred"),
			behavior("model", "honors", "Model selection hint.", "inferred"),
			behavior("metadata", "honors", "Arbitrary metadata.", "inferred"),
			behavior("category", "honors", "Skill categorization.", "inferred"),
			behavior("allowed-tools", "honors", "Tool restriction hint.", "inferred"),
			...CLAUDE_INVOCATION.map((field) =>
				behavior(field, "ignores", "Claude-specific invocation vocabulary.", "inferred"),
			),
		],
		constraints: [
			{ rule: "Skill discovery paths may differ per project; verify before relying on them.", evidence: "inferred" },
		],
		notes: [
			"No verified official source URL is recorded; the profile is inferred and the monthly check reports it as blocked (no fetchable source) rather than guessing.",
			"Runtime probes (phase 2, not built) would upgrade confidence.",
		],
	},
	opencode: {
		agent: "opencode",
		name: "OpenCode",
		observedVersion: "unknown",
		observedAt: OBSERVED_AT,
		evidence: "inferred",
		sources: [],
		behavior: [
			behavior("name", "honors", "Core Agent Skills field.", "inferred"),
			behavior("description", "requires", "Discovery suffers without it.", "inferred"),
			behavior("model", "honors", "Model selection hint.", "inferred"),
			behavior("metadata", "honors", "Arbitrary metadata.", "inferred"),
			behavior("category", "honors", "Skill categorization.", "inferred"),
			behavior("triggers", "honors", "OpenCode trigger convention.", "inferred"),
			...CLAUDE_INVOCATION.map((field) =>
				behavior(field, "ignores", "Claude-specific invocation vocabulary.", "inferred"),
			),
		],
		constraints: [
			{ rule: "Trigger conventions are opencode-specific; claude skill fields do not map.", evidence: "inferred" },
		],
		notes: [
			"No verified official source URL is recorded; the profile is inferred and the monthly check reports it as blocked (no fetchable source) rather than guessing.",
			"Runtime probes (phase 2, not built) would upgrade confidence.",
		],
	},
};

export const SEED_REGISTRY: EvidenceRegistry = {
	schemaVersion: EVIDENCE_REGISTRY_SCHEMA_VERSION,
	registryVersion: EVIDENCE_REGISTRY_VERSION,
	generatedAt: "2026-08-16T00:00:00.000Z",
	profiles: SEED_PROFILES,
};

/** Return a fresh copy of the seed registry (callers may not mutate the shared constant). */
export function defaultRegistry(): EvidenceRegistry {
	return JSON.parse(JSON.stringify(SEED_REGISTRY)) as EvidenceRegistry;
}
