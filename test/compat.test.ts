import assert from "node:assert/strict";
import test from "node:test";
import {
	AGENT_PROFILES,
	AGENT_IDS,
	compatReport,
	PROFILE_VERSION,
	type SkillCompat,
} from "../src/compat.ts";

test("pure metadata fields never flag a warn on any agent", () => {
	const report = compatReport({
		"plain-skill": [
			{
				fields: ["name", "description", "author", "license", "version"],
				location: "pi",
			},
		],
	});
	const skill = report.skills[0]!;
	for (const id of AGENT_IDS) {
		assert.equal(skill.agents[id].status, "ok", `${id} should be ok`);
	}
});

test("claude invocation fields warn on pi/codex/opencode, ok on claude", () => {
	const report = compatReport({
		"claude-skill": [
			{
				fields: [
					"name",
					"description",
					"user-invocable",
					"argument-hint",
					"arguments",
					"context",
				],
				location: "claude",
			},
		],
	});
	const skill = report.skills[0]!;
	assert.equal(skill.agents.claude.status, "ok");
	for (const id of ["pi", "codex", "opencode"] as const) {
		assert.equal(skill.agents[id].status, "warn");
		assert.ok(
			skill.agents[id].issues.some((i) => i.field === "argument-hint"),
			`${id} should flag argument-hint`,
		);
		// evidence + remediation are present per issue
		for (const issue of skill.agents[id].issues) {
			assert.ok(["documented", "inferred"].includes(issue.evidence));
			assert.ok(issue.remediation.length > 0);
		}
	}
});

test("pi honors allowed-tools and disable-model-invocation (source-validated)", () => {
	const report = compatReport({
		"pi-native": [
			{
				fields: ["name", "description", "allowed-tools", "disable-model-invocation"],
				location: "pi",
			},
		],
	});
	const skill = report.skills[0]!;
	assert.equal(skill.agents.pi.status, "ok", "pi honors these fields");
});

test("missing description produces an issue on every agent", () => {
	const report = compatReport({
		"no-desc": [{ fields: ["name"], location: "pi" }],
	});
	const skill = report.skills[0]!;
	for (const id of AGENT_IDS) {
		assert.ok(
			skill.agents[id].issues.some((i) => i.field === "description"),
			`${id} should flag missing description`,
		);
		assert.notEqual(skill.agents[id].status, "ok");
	}
});

test("unknown/custom fields are surfaced separately, not a status change", () => {
	const report = compatReport({
		"custom-skill": [
			{
				fields: ["name", "description", "some-custom-field", "another"],
				location: "pi",
			},
		],
	});
	const skill = report.skills[0]!;
	for (const id of AGENT_IDS) {
		assert.equal(skill.agents[id].status, "ok");
		assert.ok(skill.agents[id].customFields.includes("some-custom-field"));
	}
	assert.ok(report.summary.unknownFieldCount >= 4);
});

test("union of fields across copies is used", () => {
	const report = compatReport({
		"multi-copy": [
			{ fields: ["name", "description"], location: "pi" },
			{ fields: ["name", "description", "argument-hint"], location: "claude" },
		],
	});
	const skill = report.skills[0]!;
	assert.equal(skill.agents.claude.status, "ok");
	assert.equal(skill.agents.pi.status, "warn");
});

test("summary counts and issue-code aggregation are consistent", () => {
	const report = compatReport({
		a: [{ fields: ["name", "description"], location: "pi" }],
		b: [{ fields: ["name", "description", "argument-hint"], location: "claude" }],
		c: [{ fields: ["name", "description", "argument-hint"], location: "claude" }],
	});
	assert.equal(report.skills.length, 3);
	assert.equal(report.summary.anyIssue, 2);
	assert.deepEqual(report.summary.skillsWithIssues, ["b", "c"]);
	const pi = report.summary.byAgent.pi;
	assert.equal(pi.ok + pi.warn + pi.incompatible, 3);
	// argument-hint ignored by pi/codex/opencode for b and c -> count 2 x 3 = 6
	const argHint = report.summary.byIssueCode.filter(
		(ic) => ic.field === "argument-hint",
	);
	assert.equal(argHint.reduce((sum, ic) => sum + ic.count, 0), 6);
});

test("report carries a profile version", () => {
	const report = compatReport({ s: [{ fields: ["name"], location: "pi" }] });
	assert.equal(report.profileVersion, PROFILE_VERSION);
});

test("every skill gets all four agents with a valid status", () => {
	const report = compatReport({
		sample: [{ fields: ["name", "description"], location: "pi" }],
	});
	const skill: SkillCompat = report.skills[0]!;
	for (const id of AGENT_IDS) {
		assert.ok(["ok", "warn", "incompatible"].includes(skill.agents[id].status));
	}
});

test("all non-claude profiles ignore the claude invocation vocabulary", () => {
	const claudeBehavioral = ["user-invocable", "argument-hint", "arguments", "context"];
	for (const profile of AGENT_PROFILES) {
		if (profile.id === "claude") continue;
		for (const field of claudeBehavioral) {
			assert.ok(
				profile.ignores.includes(field),
				`${profile.id} should ignore ${field}`,
			);
		}
	}
});
