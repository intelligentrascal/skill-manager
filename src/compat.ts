// Portability knowledge base: what each agent runtime actually does with a
// skill's frontmatter. Knowledge-first: the profiles below are the content of
// the "compatibility engine" - grounded in documentation where possible,
// marked `inferred` where we know less. Runtime probes (phase 2) will verify
// and upgrade `inferred` entries.
//
// Severity model (deliberately conservative - no heuristic pretending to be
// authority):
//   - honors:  fields the agent acts on.
//   - ignores: BEHAVIORAL fields the agent silently ignores (intent genuinely
//              lost: an invocation mode that never triggers). These produce a
//              warn, with evidence + remediation.
//   - silent:  informational metadata (author, license, ...). Ignored, never
//              flagged - harmless.
//   - requires: fields that must be present (e.g. description). Missing ->
//              warn, or break when the agent will not load the skill at all.
//   - unknown/custom fields: surfaced separately (customFields) - distinct
//     from ok, but never a status change. We do not claim semantics we do not
//     have - that would be false authority.
//
// Pi profile validated against the pi source (2026-08-12): pi honors
// allowed-tools (experimental) and disable-model-invocation (hides the skill
// from automatic prompt discovery while /skill:name still works).

export type AgentId = "pi" | "claude" | "codex" | "opencode";

export interface AgentProfile {
	id: AgentId;
	name: string;
	/** Frontmatter keys this agent honors (semantics apply). */
	honors: string[];
	/** BEHAVIORAL keys silently ignored - intent lost, warn. */
	ignores: string[];
	/** Keys that can break or mislead this agent. */
	breaks: string[];
	/** Informational metadata - ignored, never flagged. */
	silent: string[];
	/** Fields that must be present for the skill to be usable. */
	requires: string[];
	/** Structural capabilities (dirs/files the agent executes or reads). */
	notes: string[];
	confidence: "documented" | "inferred";
}

/** The claude behavioral vocabulary: tool restrictions, invocation modes. */
const CLAUDE_BEHAVIORAL = [
	"user-invocable",
	"argument-hint",
	"arguments",
	"context",
];

const METADATA = [
	"author",
	"homepage",
	"license",
	"version",
	"category",
	"tags",
	"metadata",
	"model",
];

// Pi (this agent). Skills live in ~/.pi/agent/skills; pi reads name +
// description and the SKILL.md body.
const PI: AgentProfile = {
	id: "pi",
	name: "Pi",
	honors: [
		"name",
		"description",
		"license",
		"compatibility",
		"metadata",
		"allowed-tools", // experimental support
		"disable-model-invocation", // hides from auto-discovery; /skill:name still works
	],
	ignores: CLAUDE_BEHAVIORAL,
	breaks: [],
	silent: METADATA,
	requires: ["description"],
	notes: [
		"allowed-tools: experimental support",
		"disable-model-invocation: hidden from auto-discovery, /skill:name retains access",
		"missing description = skill is not loaded",
		"name != directory is allowed",
		"discovers global ~/.pi/agent/skills, ~/.agents/skills, trusted project .pi/skills",
	],
	confidence: "documented",
};

// Claude Code. The best-documented runtime - its Agent Skills spec lists the
// full frontmatter vocabulary.
const CLAUDE: AgentProfile = {
	id: "claude",
	name: "Claude",
	honors: [
		"name",
		"description",
		"allowed-tools",
		"disable-model-invocation",
		"user-invocable",
		"argument-hint",
		"arguments",
		"context",
		"model",
		"version",
		"license",
		"tags",
		"metadata",
	],
	ignores: [],
	breaks: [],
	silent: [
		"author",
		"homepage",
		"category",
		"domain",
		"role",
		"scope",
		"output-format",
		"related-skills",
		"hermes-tags",
		"hermes-category",
	],
	requires: ["description"],
	notes: ["Executes scripts/ and reads references/; nested skills supported."],
	confidence: "documented",
};

// Codex (OpenAI). Agent Skills support exists; core fields honored, claude's
// invocation vocabulary is claude-specific.
const CODEX: AgentProfile = {
	id: "codex",
	name: "Codex",
	honors: [
		"name",
		"description",
		"model",
		"metadata",
		"category",
		"allowed-tools",
	],
	ignores: CLAUDE_BEHAVIORAL,
	breaks: [],
	silent: METADATA,
	requires: ["description"],
	notes: [
		"Skill discovery paths may differ per project; verify before relying on it.",
	],
	confidence: "inferred",
};

// OpenCode. Loads Agent Skills from ~/.agents/skills and project dirs.
const OPENCODE: AgentProfile = {
	id: "opencode",
	name: "OpenCode",
	honors: ["name", "description", "model", "metadata", "category", "triggers"],
	ignores: CLAUDE_BEHAVIORAL,
	breaks: [],
	silent: METADATA,
	requires: ["description"],
	notes: [
		"Trigger conventions are opencode-specific; claude skill fields do not map.",
	],
	confidence: "inferred",
};

export const AGENT_PROFILES: AgentProfile[] = [PI, CLAUDE, CODEX, OPENCODE];

export const AGENT_IDS: AgentId[] = ["pi", "claude", "codex", "opencode"];

/** Version of the knowledge base. Bump when profiles change. */
export const PROFILE_VERSION = "1.1.0";

export interface CompatSuggestion {
	action: string;
	risk: "low" | "medium" | "high";
	whyMayAlter: string;
}

export interface CompatIssue {
	field: string;
	severity: "ignore" | "break" | "missing";
	evidence: "documented" | "inferred";
	note: string;
	remediation: string;
	suggestions: CompatSuggestion[];
}

export interface AgentCompat {
	status: "ok" | "warn" | "incompatible";
	issues: CompatIssue[];
	/** fields this skill uses that the profile does not know (informational). */
	customFields: string[];
}

export interface SkillCompat {
	name: string;
	agents: Record<AgentId, AgentCompat>;
}

function remediationFor(field: string, profile: AgentProfile): string {
	if (profile.breaks.includes(field)) {
		return `Drop or rewrite '${field}' - ${profile.name} cannot handle it`;
	}
	return `Drop or adapt '${field}' for ${profile.name} - its intent does not carry over`;
}

function suggestionsFor(
	field: string,
	profile: AgentProfile,
	severity: string,
): CompatSuggestion[] {
	// Invocation vocabulary (argument-hint, user-invocable, arguments, context):
	// the intent is interactive invocation on claude. Removing the field is safe
	// for the OTHER agent but changes claude's behavior - flag that.
	if (CLAUDE_BEHAVIORAL.includes(field)) {
		return [
			{
				action: `Remove '${field}' from the ${profile.name} copy, or leave it in the claude copy only`,
				risk: "medium",
				whyMayAlter: `Claude still honors '${field}' - removing it from a shared SKILL.md changes claude's invocation behavior`,
			},
			{
				action: `Fold the intent into the description for ${profile.name}`,
				risk: "low",
				whyMayAlter:
					"The model still sees the guidance, just not as structured metadata",
			},
		];
	}
	if (field === "allowed-tools") {
		return [
			{
				action:
					"Express the tool restriction in the skill body instead of allowed-tools",
				risk: "high",
				whyMayAlter:
					"Allowed-tools is a hard restriction on claude; body text is advisory everywhere",
			},
		];
	}
	if (severity === "missing") {
		return [
			{
				action: `Add a ${field} field to the frontmatter`,
				risk: "low",
				whyMayAlter:
					"Discovery and selection depend on it - adding it improves routing everywhere",
			},
		];
	}
	return [
		{
			action: `Drop or adapt '${field}' for ${profile.name}`,
			risk: "medium",
			whyMayAlter:
				"Its intent does not carry over - keeping it has no effect on this agent",
		},
	];
}

function assessAgent(fields: string[], profile: AgentProfile): AgentCompat {
	const issues: CompatIssue[] = [];
	for (const field of fields) {
		if (profile.breaks.includes(field)) {
			issues.push({
				field,
				severity: "break",
				evidence: profile.confidence,
				note: `${profile.name} breaks on frontmatter field '${field}'`,
				remediation: remediationFor(field, profile),
				suggestions: suggestionsFor(field, profile, "break"),
			});
		} else if (profile.ignores.includes(field)) {
			issues.push({
				field,
				severity: "ignore",
				evidence: profile.confidence,
				note: `${profile.name} ignores '${field}' - the intent is lost here`,
				remediation: remediationFor(field, profile),
				suggestions: suggestionsFor(field, profile, "ignore"),
			});
		}
	}
	for (const required of profile.requires) {
		if (!fields.includes(required)) {
			issues.push({
				field: required,
				severity: "missing",
				evidence: profile.confidence,
				note: `${profile.name} requires '${required}' - ${
					required === "description" && profile.id === "pi"
						? "the skill is not loaded without it"
						: "discovery suffers without it"
				}`,
				remediation: `Add a ${required} field to the frontmatter`,
				suggestions: suggestionsFor(required, profile, "missing"),
			});
		}
	}
	const known = new Set([
		...profile.honors,
		...profile.ignores,
		...profile.breaks,
		...profile.silent,
	]);
	const customFields = fields.filter((f) => !known.has(f));
	const status = issues.some((i) => i.severity === "break")
		? "incompatible"
		: issues.length > 0
			? "warn"
			: "ok";
	return { status, issues, customFields };
}

export interface CompatReport {
	profileVersion: string;
	generatedAt: string;
	skills: SkillCompat[];
	summary: {
		byAgent: Record<
			AgentId,
			{ ok: number; warn: number; incompatible: number }
		>;
		/** aggregated by issue code (agent + field), e.g. "pi ignores argument-hint: 101". */
		byIssueCode: {
			agent: AgentId;
			field: string;
			severity: string;
			count: number;
		}[];
		anyIssue: number;
		skillsWithIssues: string[];
		unknownFieldCount: number;
	};
}

/** Full portability report for an inventory. Pure function - no IO. */
export function compatReport(
	byName: Record<string, { fields: string[]; location: string }[]>,
	now = new Date(),
): CompatReport {
	const skills: SkillCompat[] = [];
	for (const [name, copies] of Object.entries(byName)) {
		if (!copies || copies.length === 0) continue;
		// union of fields across copies (a field in ANY copy is used by the skill)
		const fields = [...new Set(copies.flatMap((c) => c.fields || []))];
		const agents = {} as Record<AgentId, AgentCompat>;
		for (const profile of AGENT_PROFILES) {
			agents[profile.id] = assessAgent(fields, profile);
		}
		skills.push({ name, agents });
	}
	skills.sort((a, b) => a.name.localeCompare(b.name));

	const byAgent = {} as Record<
		AgentId,
		{ ok: number; warn: number; incompatible: number }
	>;
	for (const id of AGENT_IDS) {
		byAgent[id] = { ok: 0, warn: 0, incompatible: 0 };
	}
	const skillsWithIssues: string[] = [];
	const issueCodes = new Map<
		string,
		{ agent: AgentId; field: string; severity: string; count: number }
	>();
	let unknownFieldCount = 0;
	for (const skill of skills) {
		const hasIssue = Object.values(skill.agents).some((a) => a.status !== "ok");
		if (hasIssue) skillsWithIssues.push(skill.name);
		for (const id of AGENT_IDS) {
			const agent = skill.agents[id];
			byAgent[id][agent.status]++;
			unknownFieldCount += agent.customFields.length;
			for (const issue of agent.issues) {
				const key = `${id}|${issue.field}|${issue.severity}`;
				const entry = issueCodes.get(key);
				if (entry) entry.count++;
				else
					issueCodes.set(key, {
						agent: id,
						field: issue.field,
						severity: issue.severity,
						count: 1,
					});
			}
		}
	}

	return {
		profileVersion: PROFILE_VERSION,
		generatedAt: now.toISOString(),
		skills,
		summary: {
			byAgent,
			byIssueCode: [...issueCodes.values()].sort((a, b) => b.count - a.count),
			anyIssue: skillsWithIssues.length,
			skillsWithIssues,
			unknownFieldCount,
		},
	};
}
