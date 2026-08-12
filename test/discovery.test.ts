import assert from "node:assert/strict";
import test from "node:test";
import { resolveExplain } from "../src/discovery.ts";
import { DISCOVERY_PROFILES } from "../src/discoveryProfiles.ts";

// home-based fixture so ~-prefixed discovery paths match real copy paths
const HOME = "/c";
const copies = (): {
	location: string;
	path: string;
	sha: string;
	repoClean?: boolean;
}[] => [
	{
		location: "claude",
		path: "/c/.claude/skills/x",
		sha: "aaa",
		repoClean: true,
	},
	{
		location: "pi",
		path: "/c/.pi/agent/skills/x",
		sha: "bbb",
		repoClean: true,
	},
	{
		location: "shared",
		path: "/c/.agents/skills/x",
		sha: "ccc",
		repoClean: true,
	},
	{ location: "repo", path: "/r/skills/x", sha: "ddd", repoClean: true },
];

test("claude discovers exactly the copy in its own global path", () => {
	const r = resolveExplain("claude", DISCOVERY_PROFILES.claude, copies(), HOME);
	assert.equal(r.reasonCode, "found-global");
	assert.equal(r.candidates.length, 1);
	assert.equal(r.winner!.location, "claude");
});

test("pi discovers its own + shared copies; its copy wins on precedence", () => {
	const r = resolveExplain("pi", DISCOVERY_PROFILES.pi, copies(), HOME);
	assert.equal(r.reasonCode, "found-global");
	assert.equal(r.candidates.length, 2); // pi + shared (both global dirs pi scans)
	assert.equal(r.winner!.location, "pi");
});

test("negative case: a claude-only skill is NOT found by pi", () => {
	const claudeOnly = [
		{
			location: "claude",
			path: "/c/.claude/skills/x",
			sha: "aaa",
			repoClean: true,
		},
	];
	const r = resolveExplain("pi", DISCOVERY_PROFILES.pi, claudeOnly, HOME);
	assert.equal(r.reasonCode, "not-found");
	assert.equal(r.candidates.length, 0);
	assert.ok(r.blockers.length > 0);
});

test("repo-only skill is not discovered by any runtime (source, not a scan dir)", () => {
	const repoOnly = [
		{ location: "repo", path: "/r/skills/x", sha: "ddd", repoClean: true },
	];
	for (const id of ["pi", "claude"] as const) {
		const r = resolveExplain(id, DISCOVERY_PROFILES[id], repoOnly, HOME);
		assert.equal(r.reasonCode, "not-found", `${id} should not find repo-only`);
	}
});

test("unknown profile returns unknown-no-profile, never a guess", () => {
	const r = resolveExplain("codex", undefined, copies(), HOME);
	assert.equal(r.reasonCode, "unknown-no-profile");
	assert.equal(r.candidates.length, 0);
});

test("integrity is measured against the repo source", () => {
	const drifted = [
		{
			location: "claude",
			path: "/c/.claude/skills/x",
			sha: "aaa",
			repoClean: true,
		},
		{ location: "repo", path: "/r/skills/x", sha: "ddd", repoClean: true },
	];
	const r = resolveExplain("claude", DISCOVERY_PROFILES.claude, drifted, HOME);
	assert.equal(r.winner!.integrity, "drifted"); // aaa != ddd

	const matching = [
		{
			location: "claude",
			path: "/c/.claude/skills/x",
			sha: "ddd",
			repoClean: true,
		},
		{ location: "repo", path: "/r/skills/x", sha: "ddd", repoClean: true },
	];
	const r2 = resolveExplain(
		"claude",
		DISCOVERY_PROFILES.claude,
		matching,
		HOME,
	);
	assert.equal(r2.winner!.integrity, "matching");
});

test("unmanaged when there is no repo source to compare against", () => {
	const noRepo = [
		{
			location: "claude",
			path: "/c/.claude/skills/x",
			sha: "aaa",
			repoClean: true,
		},
	];
	const r = resolveExplain("claude", DISCOVERY_PROFILES.claude, noRepo, HOME);
	assert.equal(r.winner!.integrity, "unmanaged");
});

test("trusted-project copies are discovered but blocked until trust is verifiable", () => {
	// inline profile: an absolute trusted-project path (a future project-aware
	// scanner could produce this; the resolver must gate it correctly)
	const projProfile = {
		agent: "pi" as const,
		runtimeVersion: "0.84.1",
		evidence: "documented" as const,
		paths: [{ path: "/c/proj/.pi/skills", kind: "trusted-project" as const }],
		precedence: ["trusted-project" as const],
		precedenceEvidence: "inferred" as const,
		trustRequiredKinds: ["trusted-project" as const],
		notes: [],
	};
	const trusted = [
		{
			location: "shared",
			path: "/c/proj/.pi/skills/x",
			sha: "aaa",
			repoClean: true,
		},
	];
	const r = resolveExplain("pi", projProfile, trusted, HOME);
	assert.equal(r.reasonCode, "blocked-trust");
	assert.ok(r.blockers.length > 0);
	assert.ok(r.winner, "candidate is kept");
	assert.equal(r.winner!.location, "shared");
});

test("winner basis is honest about precedence confidence", () => {
	const multi = [
		{
			location: "claude",
			path: "/c/.claude/skills/x",
			sha: "aaa",
			repoClean: true,
		},
		{
			location: "pi",
			path: "/c/.pi/agent/skills/x",
			sha: "bbb",
			repoClean: true,
		},
		{
			location: "shared",
			path: "/c/.agents/skills/x",
			sha: "ccc",
			repoClean: true,
		},
	];
	// pi: multiple matching candidates + inferred precedence -> precedence-inferred
	const r = resolveExplain("pi", DISCOVERY_PROFILES.pi, multi, HOME);
	assert.equal(r.winnerBasis, "precedence-inferred");
	// claude: only its own path matches -> unique (not a precedence claim)
	const r2 = resolveExplain("claude", DISCOVERY_PROFILES.claude, multi, HOME);
	assert.equal(r2.winnerBasis, "unique");
	// inline profile with documented precedence + two kinds -> precedence-documented
	const docProfile = {
		agent: "claude" as const,
		runtimeVersion: "2.x",
		evidence: "documented" as const,
		paths: [
			{ path: "/c/.claude/skills", kind: "global" as const },
			{ path: "/c/proj/.claude/skills", kind: "project" as const },
		],
		precedence: ["project" as const, "global" as const],
		precedenceEvidence: "documented" as const,
		trustRequiredKinds: [],
		notes: [],
	};
	const twoKinds = [
		{
			location: "claude",
			path: "/c/.claude/skills/x",
			sha: "aaa",
			repoClean: true,
		},
		{
			location: "claude",
			path: "/c/proj/.claude/skills/x",
			sha: "bbb",
			repoClean: true,
		},
	];
	const r3 = resolveExplain("claude", docProfile, twoKinds, HOME);
	assert.equal(r3.winnerBasis, "precedence-documented");
});

test("all shipped profiles carry evidence and version facts", () => {
	for (const [id, profile] of Object.entries(DISCOVERY_PROFILES)) {
		assert.ok(profile.runtimeVersion.length > 0, `${id} runtimeVersion`);
		assert.ok(["documented", "inferred", "unknown"].includes(profile.evidence));
		assert.ok(profile.paths.length > 0, `${id} paths`);
		assert.ok(profile.precedence.length > 0, `${id} precedence`);
		assert.ok(
			["documented", "inferred", "unknown"].includes(
				profile.precedenceEvidence,
			),
			`${id} precedenceEvidence`,
		);
	}
});
