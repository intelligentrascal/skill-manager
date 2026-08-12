import assert from "node:assert/strict";
import test from "node:test";
import { buildHealthActions } from "../src/health.ts";

test("prioritizes drift and ignores healthy duplicates", () => {
	const actions = buildHealthActions({
		byName: {
			alpha: [
				{ location: "pi", sha: "one" },
				{ location: "shared", sha: "two" },
			],
			beta: [
				{ location: "pi", sha: "same" },
				{ location: "shared", sha: "same" },
			],
		},
	});

	assert.deepEqual(
		actions.map((action) => action.skill),
		["alpha"],
	);
	assert.deepEqual(actions[0], {
		kind: "drift",
		priority: "high",
		skill: "alpha",
		title: "Resolve drift",
		detail: "pi and shared have different SKILL.md content.",
	});
});

test("identifies repo copies that differ from git HEAD", () => {
	const actions = buildHealthActions({
		byName: {
			local_only: [{ location: "repo", sha: "current", repoClean: false }],
		},
	});

	assert.deepEqual(actions, [
		{
			kind: "repo_dirty",
			priority: "medium",
			skill: "local_only",
			title: "Review repo change",
			detail: "Git status reports that the repo copy changed from HEAD.",
		},
	]);
});
