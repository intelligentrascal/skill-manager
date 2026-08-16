import assert from "node:assert/strict";
import test from "node:test";
import {
	generateAdaptationReview,
	type AdaptationReviewInput,
} from "../src/adaptationReview.ts";
import { adaptSkill } from "../src/variant.ts";
import { defaultRegistry } from "../src/evidenceRegistry.ts";

function makeInput(
	overrides: Partial<AdaptationReviewInput> = {},
): AdaptationReviewInput {
	return {
		skill: "review",
		baselineRevision: "base-1",
		upstreamRevision: "in-rev",
		baselineContent:
			"---\nname: review\ndescription: Old description\nuser-invocable: true\n---\nBody one.\n",
		upstreamContent:
			"---\nname: review\ndescription: New description\nuser-invocable: true\nmodel: gpt-5\n---\nBody two.\n",
		registry: defaultRegistry(),
		now: new Date("2026-08-16T18:00:00.000Z"),
		...overrides,
	} as AdaptationReviewInput;
}

function proposal(review: ReturnType<typeof generateAdaptationReview>, agent: string) {
	return review.agents.find((a) => a.agent === agent)!;
}

test("the review captures the canonical and source revisions plus the profile revision", () => {
	const review = generateAdaptationReview(makeInput(), "k");
	assert.equal(review.skill, "review");
	assert.equal(review.canonicalRevision, "base-1");
	assert.equal(review.sourceRevision, "in-rev");
	assert.equal(review.agentProfileRevision, "1.0.0");
	assert.equal(review.cacheHit, false);
});

test("AC1: upstream changes are identified and explained per affected agent", () => {
	const review = generateAdaptationReview(makeInput(), "k");
	const summary = review.changeSummary;
	assert.deepEqual(
		summary.changedFields.map((f) => [f.field, f.change]),
		[
			["description", "modified"],
			["model", "added"],
		],
	);
	assert.equal(summary.bodyChanged, true);
	assert.match(summary.summary, /modified description/);
	assert.match(summary.summary, /added model/);
	// Every target agent has an impact entry for the changed fields.
	for (const agent of review.agents) {
		assert.equal(agent.impact.length, 2);
	}
	// pi knows description (requires) but not model (unknown mapping).
	const pi = proposal(review, "pi");
	const desc = pi.impact.find((i) => i.field === "description");
	assert.equal(desc?.treatment, "requires");
	assert.equal(desc?.evidence, "documented");
	const model = pi.impact.find((i) => i.field === "model");
	assert.equal(model?.treatment, "unknown");
	assert.equal(model?.evidence, "unknown");
});

test("AC2: proposed variants carry evidence and uncertainty visibly", () => {
	const review = generateAdaptationReview(makeInput(), "k");
	// codex is inferred - its proposal must surface the confidence caveat.
	const codex = proposal(review, "codex");
	assert.equal(codex.evidence.level, "inferred");
	assert.ok(
		codex.uncertainty.some((u) => /inferred/.test(u)),
		"inferred-profile uncertainty should be visible",
	);
	// A proposed variant was generated (codex drops the claude-invocation field).
	assert.equal(codex.status, "proposed");
	assert.ok(codex.proposed, "codex should have a proposed variant");
	assert.ok(
		codex.proposed!.removed.includes("user-invocable"),
		"codex adaptation removes the claude-invocation field",
	);
	// opencode is also proposed and adds its trigger convention.
	const opencode = proposal(review, "opencode");
	assert.equal(opencode.status, "proposed");
	assert.ok(opencode.proposed!.added.includes("triggers"));
});

test("AC4: unknown or unsupported mappings block apply rather than inventing", () => {
	const review = generateAdaptationReview(makeInput(), "k");
	const pi = proposal(review, "pi");
	// model is an unknown mapping for pi -> blocked, with an explicit condition.
	assert.equal(pi.status, "blocked");
	assert.ok(
		pi.blockingConditions.some((c) => /model/.test(c) && /blocked/i.test(c)),
		"pi should be blocked on the unknown 'model' mapping",
	);
	// The would-be candidate is still shown (honest), but no content invented.
	assert.ok(pi.proposed, "the rule-based candidate is shown for review");
	assert.equal(
		typeof pi.proposed!.content,
		"string",
		"proposed content is deterministic, never fabricated",
	);
});

test("AC4: a skill a model cannot adapt (no frontmatter) is blocked with no invented content", () => {
	const input = makeInput({
		upstreamContent: "Just a bare skill body with no frontmatter block.\n",
	});
	const review = generateAdaptationReview(input, "k");
	for (const agent of review.agents) {
		assert.equal(agent.status, "blocked");
		assert.equal(agent.proposed, null, "no variant is invented");
		assert.ok(
			agent.blockingConditions.some((c) => /frontmatter/i.test(c)),
			"blocking reason names the missing frontmatter",
		);
	}
});

test("canonical status when no adaptation is required for the agent", () => {
	const input = makeInput({
		baselineContent:
			"---\nname: review\ndescription: Same\n---\nBody stable.\n",
		upstreamContent:
			"---\nname: review\ndescription: Same\n---\nBody stable.\n",
	});
	const review = generateAdaptationReview(input, "k");
	assert.equal(review.changeSummary.changedFields.length, 0);
	assert.equal(review.changeSummary.bodyChanged, false);
	// claude is the authoring agent: identical canonical, no adaptation needed.
	assert.equal(proposal(review, "claude").status, "canonical");
	assert.equal(proposal(review, "claude").proposed, null);
});

test("proposed variant content matches the deterministic adapter output", () => {
	const input = makeInput();
	const review = generateAdaptationReview(input, "k");
	const codex = proposal(review, "codex");
	const expected = adaptSkill(input.upstreamContent, "codex").content;
	assert.equal(codex.proposed!.content, expected);
});
