// Adaptation Review cache (ticket #6, AC3).
//
// Results are cached by the pair (canonical revision, agent-profile revision)
// - plus the skill name as namespace. When neither input changed, the prior
// analysis is reused WITHOUT invoking the generator again (no "model work").
//
// The generator is injectable so tests can assert invocation counts and so a
// real model could be plugged in later without touching the cache seam.
// The cache is pure/in-memory: it holds no machine paths and never touches
// the filesystem, so it is safe to unit-test and to keep resident per process.

import {
	generateAdaptationReview,
	type AdaptationReview,
	type AdaptationReviewInput,
} from "./adaptationReview.ts";

export interface ReviewCache {
	get(key: string): AdaptationReview | undefined;
	set(key: string, review: AdaptationReview): void;
	has(key: string): boolean;
}

/** The cache key: a skill namespaced by the (canonical, profile) revision pair. */
export function reviewCacheKey(
	skill: string,
	canonicalRevision: string,
	agentProfileRevision: string,
): string {
	return `${skill}::${canonicalRevision}::${agentProfileRevision}`;
}

/** In-memory cache. A cache hit never calls the generator. */
export class MemoryReviewCache implements ReviewCache {
	private readonly store = new Map<string, AdaptationReview>();

	get(key: string): AdaptationReview | undefined {
		const hit = this.store.get(key);
		return hit ? { ...hit, cacheHit: true } : undefined;
	}

	set(key: string, review: AdaptationReview): void {
		// Stored entries always carry cacheHit:false; the hit flag is applied on read.
		this.store.set(key, { ...review, cacheHit: false });
	}

	has(key: string): boolean {
		return this.store.has(key);
	}
}

/**
 * Return a cached review when the (canonical, profile) pair is unchanged;
 * otherwise generate, store, and return it. `generator` is the only code that
 * performs model work - on a cache hit it is never called.
 */
export function cachedAdaptationReview(
	input: AdaptationReviewInput,
	cache: ReviewCache,
	generator: (
		input: AdaptationReviewInput,
		key: string,
	) => AdaptationReview = generateAdaptationReview,
): AdaptationReview {
	const profileRevision = input.registry?.registryVersion ?? "unknown";
	// The canonical revision is the skill content's own revision (the upstream
	// source revision) - that is the input that, with the profile revision,
	// determines the generated analysis.
	const key = reviewCacheKey(
		input.skill,
		input.upstreamRevision,
		profileRevision,
	);
	const existing = cache.get(key);
	if (existing) return existing; // cacheHit already true
	const review = generator(input, key);
	cache.set(key, review);
	return { ...review, cacheHit: false };
}
