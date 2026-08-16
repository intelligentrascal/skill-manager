import assert from "node:assert/strict";
import test from "node:test";
import {
	cachedAdaptationReview,
	MemoryReviewCache,
	reviewCacheKey,
} from "../src/reviewCache.ts";
import {
	generateAdaptationReview,
	type AdaptationReviewInput,
} from "../src/adaptationReview.ts";
import { defaultRegistry } from "../src/evidenceRegistry.ts";

function makeInput(
	overrides: Partial<AdaptationReviewInput> = {},
): AdaptationReviewInput {
	return {
		skill: "review",
		baselineRevision: "base-1",
		upstreamRevision: "in-rev",
		baselineContent:
			"---\nname: review\ndescription: Old\n---\nBody one.\n",
		upstreamContent:
			"---\nname: review\ndescription: New\n---\nBody two.\n",
		registry: defaultRegistry(),
		now: new Date("2026-08-16T18:00:00.000Z"),
		...overrides,
	};
}

test("AC3: unchanged (canonical, profile) pair reuses prior analysis without invoking the model", () => {
	let calls = 0;
	const generator = (
		input: AdaptationReviewInput,
		key: string,
	) => {
		calls += 1;
		return generateAdaptationReview(input, key);
	};
	const cache = new MemoryReviewCache();
	const input = makeInput();

	const first = cachedAdaptationReview(input, cache, generator);
	assert.equal(first.cacheHit, false);

	const second = cachedAdaptationReview(input, cache, generator);
	assert.equal(second.cacheHit, true);
	// The generator (the only model work) ran exactly once.
	assert.equal(calls, 1);
	// The reused review is structurally identical to the generated one.
	assert.deepEqual(second.changeSummary, first.changeSummary);
	assert.deepEqual(
		second.agents.map((a) => a.status),
		first.agents.map((a) => a.status),
	);
});

test("AC3: a changed canonical or profile revision produces a fresh analysis", () => {
	let calls = 0;
	const generator = (input: AdaptationReviewInput, key: string) => {
		calls += 1;
		return generateAdaptationReview(input, key);
	};
	const cache = new MemoryReviewCache();

	cachedAdaptationReview(makeInput(), cache, generator);
	// Different upstream (canonical) revision -> new key -> regenerate.
	cachedAdaptationReview(
		makeInput({ upstreamRevision: "in-rev-2" }),
		cache,
		generator,
	);
	// Different agent-profile revision -> new key -> regenerate.
	cachedAdaptationReview(
		makeInput({
			registry: { ...defaultRegistry(), registryVersion: "1.0.1" },
		}),
		cache,
		generator,
	);

	assert.equal(calls, 3);
});

test("reviewCacheKey combines skill, canonical revision, and profile revision", () => {
	const a = reviewCacheKey("review", "base-1", "1.0.0");
	const b = reviewCacheKey("review", "base-2", "1.0.0");
	const c = reviewCacheKey("review", "base-1", "1.0.1");
	assert.notEqual(a, b);
	assert.notEqual(a, c);
	assert.equal(reviewCacheKey("review", "base-1", "1.0.0"), a);
});

test("an empty cache reports no hit", () => {
	const cache = new MemoryReviewCache();
	assert.equal(cache.has(reviewCacheKey("review", "base-1", "1.0.0")), false);
	assert.equal(
		cache.get(reviewCacheKey("review", "base-1", "1.0.0")),
		undefined,
	);
});
