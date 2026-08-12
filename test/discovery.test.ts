import assert from "node:assert/strict";
import test from "node:test";
import { resolveExplain } from "../src/discovery.ts";
import { DISCOVERY_PROFILES } from "../src/discoveryProfiles.ts";

// home-based fixture so ~-prefixed discovery paths match real copy paths
const HOME = "/c";
const copies = (): { location: string; path: string; sha: string; repoClean?: boolean }[] => [
	{ location: "claude", path: "/c/.claude/skills/x", sha: "aaa", repoClean: true },
	{ location: "pi", path: "/c/.pi/agent/skills/x", sha: "bbb", repoClean: true },
	{ location: "shared", path: "/c/.agents/skills/x", sha: "ccc", repoClean: true },
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
		{ location: "claude", path: "/c/.claude/skills/x", sha: "aaa", repoClean: true },
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
		{ location: "claude", path: "/c/.claude/skills/x", sha: "aaa", repoClean: true },
		{ location: "repo", path: "/r/skills/x", sha: "ddd", repoClean: true },
	];
	const r = resolveExplain("claude", DISCOVERY_PROFILES.claude, drifted, HOME);
	assert.equal(r.winner!.integrity, "drifted"); // aaa != ddd

	const matching = [
		{ location: "claude", path: "/c/.claude/skills/x", sha: "ddd", repoClean: true },
		{ location: "repo", path: "/r/skills/x", sha: "ddd", repoClean: true },
	];
	const r2 = resolveExplain("claude", DISCOVERY_PROFILES.claude, matching, HOME);
	assert.equal(r2.winner!.integrity, "matching");
});

test("unmanaged when there is no repo source to compare against", () => {
	const noRepo = [
		{ location: "claude", path: "/c/.claude/skills/x", sha: "aaa", repoClean: true },
	];
	const r = resolveExplain("claude", DISCOVERY_PROFILES.claude, noRepo, HOME);
	assert.equal(r.winner!.integrity, "unmanaged");
});

test("all shipped profiles carry evidence and version facts", () => {
	for (const [id, profile] of Object.entries(DISCOVERY_PROFILES)) {
		assert.ok(profile.runtimeVersion.length > 0, `${id} runtimeVersion`);
		assert.ok(["documented", "inferred", "unknown"].includes(profile.evidence));
		assert.ok(profile.paths.length > 0, `${id} paths`);
		assert.ok(profile.precedence.length > 0, `${id} precedence`);
	}
});
