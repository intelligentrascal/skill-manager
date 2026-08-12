// Discovery knowledge: what each agent runtime scans, and how to resolve which
// copy of a skill that runtime would actually load. Schema owned centrally
// (this file) so per-agent facts never become a contested merge hotspot.
//
// Honesty rules (from the plan grill):
// - `evidence: unknown` when we do not have versioned proof. Never guess.
// - reasonCode is the stable API contract; verdict prose is UI-side.
// - a runtime may discover multiple colliding copies - the winner is resolved
//   by the profile's precedence, and everything else stays in candidates[].
// - matching is by RESOLVED PATH PREFIX, not by location name: pi scans
//   ~/.pi/agent/skills and ~/.agents/skills; it does NOT scan ~/.claude/skills
//   even though all three are "global" directories.

import type { AgentId } from "./compat.ts";

export type Evidence = "documented" | "inferred" | "unknown";
export type Integrity = "matching" | "drifted" | "unmanaged" | "unknown";

export interface DiscoveryPath {
	path: string;
	kind: "global" | "project" | "trusted-project" | "package" | "explicit";
	/** env var that overrides this path (if any). */
	env?: string;
	/** set by the filesystem probe; null until probed. */
	exists?: boolean;
	/** per-path context (e.g. trust requirement, discovery nuance). */
	notes?: string[];
}

export interface DiscoveryProfile {
	agent: AgentId;
	/** runtime version the facts were validated against. */
	runtimeVersion: string;
	evidence: Evidence;
	/** ISO timestamp of the last probe/validation. */
	checkedAt?: string;
	paths: DiscoveryPath[];
	/** order wins on collision (first listed = highest precedence). */
	precedence: DiscoveryPath["kind"][];
	/** confidence in the cross-category precedence ordering itself. */
	precedenceEvidence: Evidence;
	/** kinds that need approval before the runtime LOADS them (pi: trusted-project). */
	trustRequiredKinds: DiscoveryPath["kind"][];
	notes: string[];
}

export type ExplainReasonCode =
	| "found-global"
	| "found-project"
	| "found-trusted-project"
	| "found-explicit"
	| "found-package"
	| "not-found"
	| "blocked-trust"
	| "blocked-disabled"
	| "unknown-no-profile";

export interface ExplainCandidate {
	location: string;
	path: string;
	kind: DiscoveryPath["kind"];
	integrity: Integrity;
	sha: string;
}

export interface ExplainResult {
	agent: AgentId;
	reasonCode: ExplainReasonCode;
	candidates: ExplainCandidate[];
	winner?: ExplainCandidate;
	/** how confident the winner pick is - never overclaim order we lack. */
	winnerBasis?: "unique" | "precedence-documented" | "precedence-inferred";
	/** human-readable blockers (path missing, trust not granted, ...). */
	blockers: string[];
}

export interface ExplainReport {
	name: string;
	generatedAt: string;
	agents: Record<AgentId, ExplainResult>;
}

/** Map an inventory location name to the discovery kind it expresses. */
export const LOCATION_KINDS: Record<string, DiscoveryPath["kind"]> = {
	pi: "global",
	claude: "global",
	opencode: "global",
	shared: "global",
	repo: "package",
};

/** Resolve ~ in a path against the current home. */
export function resolveHome(path: string, home: string): string {
	return path.startsWith("~/") || path === "~" ? path.replace(/^~/, home) : path;
}

/** True if this discovery path can be matched against a concrete dir. */
function isMatchable(p: DiscoveryPath): boolean {
	return !p.path.includes(":") && !p.path.startsWith("--") && !p.path.startsWith("-");
}

/**
 * Resolve which copy a runtime would load, given its profile and the inventory.
 * Pure function - no IO, no version claims beyond the profile's own evidence.
 *
 * @param home expanded home dir so ~-prefixed discovery paths match copy paths.
 */
export function resolveExplain(
	agent: AgentId,
	profile: DiscoveryProfile | undefined,
	copies:
		| { location: string; path: string; sha: string; repoClean?: boolean }[]
		| undefined,
	home = "",
): ExplainResult {
	const blockers: string[] = [];
	if (!profile || profile.evidence === "unknown") {
		return {
			agent,
			reasonCode: "unknown-no-profile",
			candidates: [],
			blockers: ["no versioned discovery profile for this runtime"],
		};
	}

	const scannedPaths: { kind: DiscoveryPath["kind"]; path: string }[] = [];
	for (const p of profile.paths) {
		if (!isMatchable(p)) continue;
		scannedPaths.push({
			kind: p.kind,
			path: resolveHome(p.path, home).replace(/\\/g, "/"),
		});
	}

	// canonical source: the repo copy, when present - integrity is measured
	// against it (the winner matches the source or it has drifted)
	const repoCopy = (copies || []).find((c) => c.location === "repo");

	const candidates: ExplainCandidate[] = [];
	for (const copy of copies || []) {
		if (copy.location === "repo") continue; // source, not a discovery target
		const copyNorm = copy.path.replace(/\\/g, "/");
		const match = scannedPaths.find(
			(sp) => copyNorm.startsWith(sp.path) || sp.path.startsWith(copyNorm),
		);
		if (!match) continue;
		let integrity: Integrity;
		if (repoCopy) {
			integrity = copy.sha === repoCopy.sha ? "matching" : "drifted";
		} else {
			integrity = "unmanaged";
		}
		candidates.push({
			location: copy.location,
			path: copy.path,
			kind: match.kind,
			integrity,
			sha: copy.sha,
		});
	}

	if (candidates.length === 0) {
		return {
			agent,
			reasonCode: "not-found",
			candidates: [],
			blockers: ["no copy in any path this runtime scans"],
		};
	}

	const KIND_REASON: Record<DiscoveryPath["kind"], ExplainReasonCode> = {
		global: "found-global",
		project: "found-project",
		"trusted-project": "found-trusted-project",
		package: "found-package",
		explicit: "found-explicit",
	};
	const winnerBasis =
		candidates.length === 1
			? "unique"
			: profile.precedenceEvidence === "documented"
				? "precedence-documented"
				: "precedence-inferred";
	for (const kind of profile.precedence) {
		const match = candidates.find((c) => c.kind === kind);
		if (!match) continue;
		// trust-gated kinds load only after approval; the scanner cannot verify
		// approval, so the honest answer is blocked-trust (candidate kept).
		if (profile.trustRequiredKinds.includes(kind)) {
			return {
				agent,
				reasonCode: "blocked-trust",
				candidates,
				winner: match,
				winnerBasis,
				blockers: [
					"discovered but not loaded - project trust is required and cannot be verified from the scanner",
				],
			};
		}
		return {
			agent,
			reasonCode: KIND_REASON[kind],
			candidates,
			winner: match,
			winnerBasis,
			blockers,
		};
	}

	return {
		agent,
		reasonCode: "not-found",
		candidates,
		blockers: ["copies exist but no precedence entry matched"],
	};
}
