// Adaptation Review: the AI-assisted generation layer (ticket #6).
//
// An upstream revision produces a review that identifies behavior changes,
// explains their per-agent impact using the ACTIVE evidence-backed agent
// profiles, proposes each affected variant, and makes evidence + uncertainty
// visible. Unknown or unsupported mappings BLOCK apply rather than inventing
// an adaptation. The actual verified apply/deploy transaction (#7) is not
// built here.
//
// Purity: generateAdaptationReview is a pure function over
//   (skill, baselineRevision, upstreamRevision, baselineContent, upstreamContent, registry).
// The "model work" is this generation step. Caching (see reviewCache.ts) wraps
// it so an unchanged (canonicalRevision, agentProfileRevision) pair reuses the
// prior analysis without invoking the generator again.

import type { AgentId } from "./compat.ts";
import {
	type AdaptationConstraint,
	type BehaviorClaim,
	type EvidenceLevel,
	type EvidenceRegistry,
	type Treatment,
} from "./evidenceRegistry.ts";
import { adaptSkill, type AdaptResult } from "./variant.ts";
import {
	readableDifference,
	type VariantDifference,
} from "./diff.ts";

const AGENTS: Array<{ agent: AgentId; label: string }> = [
	{ agent: "pi", label: "Pi" },
	{ agent: "claude", label: "Claude" },
	{ agent: "opencode", label: "OpenCode" },
	{ agent: "codex", label: "Codex" },
];

const SILENT_METADATA = new Set([
	"license",
	"author",
	"version",
	"tags",
	"category",
]);

export type ProposalStatus = "proposed" | "blocked" | "canonical";

export interface ChangedField {
	field: string;
	change: "added" | "removed" | "modified";
	before?: string;
	after?: string;
}

export interface ChangeSummary {
	sourceRevision: string;
	canonicalRevision: string;
	changedFields: ChangedField[];
	bodyChanged: boolean;
	addedLines: number;
	removedLines: number;
	summary: string;
}

export interface ImpactFinding {
	field: string;
	treatment: Treatment | "unknown";
	evidence: EvidenceLevel;
	note: string;
}

export interface ProposalEvidence {
	level: EvidenceLevel;
	observedVersion: string;
	observedAt: string;
	basis: string[];
}

export interface ProposedVariant {
	content: string;
	diff: VariantDifference;
	removed: string[];
	added: string[];
	carryOver: string[];
}

export interface AgentAdaptationProposal {
	agent: AgentId;
	label: string;
	status: ProposalStatus;
	impact: ImpactFinding[];
	proposed: ProposedVariant | null;
	evidence: ProposalEvidence;
	uncertainty: string[];
	blockingConditions: string[];
}

export interface AdaptationReview {
	skill: string;
	generatedAt: string;
	sourceRevision: string;
	canonicalRevision: string;
	agentProfileRevision: string;
	cacheKey: string;
	cacheHit: boolean;
	changeSummary: ChangeSummary;
	agents: AgentAdaptationProposal[];
}

export interface AdaptationReviewInput {
	skill: string;
	baselineRevision: string;
	upstreamRevision: string;
	baselineContent: string;
	upstreamContent: string;
	registry?: EvidenceRegistry;
	now?: Date;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (self-contained; mirrors variant.ts parsing intent).
// ---------------------------------------------------------------------------

function parseFrontmatterBlock(content: string): {
	raw: string;
	lines: string[];
	body: string;
} | null {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n"))
		return null;
	const end = content.indexOf("\n---");
	if (end === -1) return null;
	const raw = content.slice(0, end + 1);
	const lines = raw.split(/\r?\n/).slice(1, -1);
	const body = content.slice(end + 4);
	return { raw, lines, body };
}

function keyOf(line: string): string | null {
	const idx = line.indexOf(":");
	if (idx === -1) return null;
	const key = line.slice(0, idx).trim();
	return /^[a-zA-Z][a-zA-Z0-9-]*$/.test(key) ? key : null;
}

interface Frontmatter {
	hasFrontmatter: boolean;
	fields: Record<string, string>;
	body: string;
}

function extractFrontmatter(content: string): Frontmatter {
	const block = parseFrontmatterBlock(content);
	if (!block) {
		return { hasFrontmatter: false, fields: {}, body: content };
	}
	const fields: Record<string, string> = {};
	for (const line of block.lines) {
		const key = keyOf(line);
		if (!key) continue;
		if (key in fields) continue; // first occurrence wins
		fields[key] = line.slice(line.indexOf(":") + 1).trim();
	}
	return { hasFrontmatter: true, fields, body: block.body };
}

// ---------------------------------------------------------------------------
// Change detection between baseline and upstream.
// ---------------------------------------------------------------------------

function normalize(text: string): string {
	return text.replaceAll("\r\n", "\n").replace(/^\n+|\n+$/g, "");
}

function buildChangeSummary(
	input: AdaptationReviewInput,
	lineDiff: VariantDifference,
): ChangeSummary {
	const baseline = extractFrontmatter(input.baselineContent);
	const upstream = extractFrontmatter(input.upstreamContent);
	const changedFields: ChangedField[] = [];
	const baseKeys = Object.keys(baseline.fields);
	const upKeys = Object.keys(upstream.fields);
	const allKeys = [...new Set([...baseKeys, ...upKeys])];
	for (const field of allKeys) {
		const before = baseline.fields[field];
		const after = upstream.fields[field];
		if (before === undefined && after !== undefined) {
			changedFields.push({ field, change: "added", after });
		} else if (before !== undefined && after === undefined) {
			changedFields.push({ field, change: "removed", before });
		} else if (before !== after) {
			changedFields.push({ field, change: "modified", before, after });
		}
	}
	const bodyChanged = normalize(baseline.body) !== normalize(upstream.body);

	const parts: string[] = [];
	const added = changedFields.filter((f) => f.change === "added").map((f) => f.field);
	const removed = changedFields
		.filter((f) => f.change === "removed")
		.map((f) => f.field);
	const modified = changedFields
		.filter((f) => f.change === "modified")
		.map((f) => f.field);
	if (added.length) parts.push(`added ${added.join(", ")}`);
	if (removed.length) parts.push(`removed ${removed.join(", ")}`);
	if (modified.length) parts.push(`modified ${modified.join(", ")}`);
	if (bodyChanged) parts.push("changed the body");
	const summary =
		parts.length === 0
			? `Upstream revision ${input.upstreamRevision} introduces no change from ${input.baselineRevision}.`
			: `Upstream revision ${input.upstreamRevision} ${parts.join("; ")}.`;

	const addedLines = lineDiff.lines.filter((l) => l.kind === "added").length;
	const removedLines = lineDiff.lines.filter((l) => l.kind === "removed").length;
	return {
		sourceRevision: input.upstreamRevision,
		canonicalRevision: input.baselineRevision,
		changedFields,
		bodyChanged,
		addedLines,
		removedLines,
		summary,
	};
}

// ---------------------------------------------------------------------------
// Per-agent impact + proposal generation.
// ---------------------------------------------------------------------------

function claimFor(
	profile: EvidenceRegistry["profiles"][AgentId] | undefined,
	field: string,
): BehaviorClaim | undefined {
	return profile?.behavior.find((claim) => claim.field === field);
}

function evidenceFor(
	registry: EvidenceRegistry | undefined,
	agent: AgentId,
): ProposalEvidence {
	const profile = registry?.profiles[agent];
	return profile
		? {
				level: profile.evidence,
				observedVersion: profile.observedVersion,
				observedAt: profile.observedAt,
				basis: profile.constraints.map((constraint: AdaptationConstraint) => constraint.rule),
			}
		: {
				level: "unknown",
				observedVersion: "unknown",
				observedAt: "unknown",
				basis: [],
			};
}

function buildImpact(
	registry: EvidenceRegistry | undefined,
	agent: AgentId,
	changedFields: ChangedField[],
): { impact: ImpactFinding[]; unknownMappings: string[] } {
	const profile = registry?.profiles[agent];
	const impact: ImpactFinding[] = [];
	const unknownMappings: string[] = [];
	for (const changed of changedFields) {
		const field = changed.field;
		const claim = claimFor(profile, field);
		if (claim) {
			impact.push({
				field,
				treatment: claim.treatment,
				evidence: claim.evidence,
				note: claim.note,
			});
		} else {
			impact.push({
				field,
				treatment: "unknown",
				evidence: "unknown",
				note: `No evidence-backed mapping for '${field}' on ${agent}.`,
			});
			unknownMappings.push(field);
		}
	}
	return { impact, unknownMappings };
}

function buildProposal(
	input: AdaptationReviewInput,
	agent: AgentId,
	label: string,
	changeSummary: ChangeSummary,
	registry: EvidenceRegistry | undefined,
): AgentAdaptationProposal {
	const { impact, unknownMappings } = buildImpact(
		registry,
		agent,
		changeSummary.changedFields,
	);
	const evidence = evidenceFor(registry, agent);

	// Honest adaptation: run the deterministic adapter. A blocked adapter means
	// we cannot safely adapt (e.g. no frontmatter) - we do NOT invent content.
	const adapt: AdaptResult = adaptSkill(input.upstreamContent, agent);
	const blockingConditions: string[] = [];
	const uncertainty: string[] = [];

	if (adapt.blocked) {
		blockingConditions.push(adapt.blocked);
	}

	// Confidence caveats: inferred/unknown profiles cannot be trusted to adapt.
	if (evidence.level === "unknown") {
		uncertainty.push(
			`No active agent profile for ${label}; adaptation is not evidence-backed.`,
		);
	} else if (evidence.level === "inferred") {
		uncertainty.push(
			`The ${label} profile is inferred (no verified official source); behavior claims may be wrong.`,
		);
	}

	// Unknown or unsupported mappings block apply rather than inventing one.
	for (const field of unknownMappings) {
		if (SILENT_METADATA.has(field)) {
			uncertainty.push(
				`Field '${field}' has no evidence-backed mapping on ${label}; treated as silent metadata, but apply is blocked until profiled.`,
			);
		} else {
			blockingConditions.push(
				`Field '${field}' has no evidence-backed mapping on ${label}; adaptation would invent behavior, so apply is blocked.`,
			);
		}
	}

	const status: ProposalStatus = blockingConditions.length
		? "blocked"
		: "proposed";

	let proposed: ProposedVariant | null = null;
	if (!adapt.blocked) {
		// Even when blocked, keep the would-be candidate visible so the reviewer
		// sees exactly what the rule-based adapter produced and why apply is
		// held. We never invent content - adaptSkill is deterministic.
		const diff = readableDifference(input.upstreamContent, adapt.content);
		proposed = {
			content: adapt.content,
			diff,
			removed: adapt.removed,
			added: adapt.added,
			carryOver: adapt.carryOver,
		};
		if (status !== "blocked" && diff.lines.every((line) => line.kind === "context")) {
			// No adaptation needed for this agent: it can use the canonical
			// content directly.
			return {
				agent,
				label,
				status: "canonical",
				impact,
				proposed: null,
				evidence,
				uncertainty,
				blockingConditions,
			};
		}
	}

	return {
		agent,
		label,
		status,
		impact,
		proposed,
		evidence,
		uncertainty,
		blockingConditions,
	};
}

/**
 * Pure Adaptation Review generator (the "model work"). Given the canonical
 * revision plus the active agent-profile revision's content and registry, it
 * produces the full review. Side-effect-free so it is directly unit-testable
 * and safe to memoize by cache key.
 */
export function generateAdaptationReview(
	input: AdaptationReviewInput,
	cacheKey: string,
): AdaptationReview {
	const registry = input.registry;
	const lineDiff = readableDifference(
		input.baselineContent,
		input.upstreamContent,
	);
	const changeSummary = buildChangeSummary(input, lineDiff);

	const agents = AGENTS.map(({ agent, label }) =>
		buildProposal(input, agent, label, changeSummary, registry),
	);

	return {
		skill: input.skill,
		generatedAt: (input.now ?? new Date()).toISOString(),
		sourceRevision: input.upstreamRevision,
		canonicalRevision: input.baselineRevision,
		agentProfileRevision: registry?.registryVersion ?? "unknown",
		cacheKey,
		cacheHit: false,
		changeSummary,
		agents,
	};
}
