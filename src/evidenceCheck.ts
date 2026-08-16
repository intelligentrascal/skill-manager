// Evidence check: the monthly (or on-demand) official-source check.
//
// It fetches each profile's FETCHABLE sources, compares the content hash with
// the active registry, and produces a reviewable proposal (an evidence diff).
// It NEVER mutates the active registry and never touches the adaptation rules
// (AC3) - the proposal is left pending in Attention until explicitly approved.
//
// Honesty: a hash change is reported as "changed" (review required), never
// auto-interpreted as a new behavior fact. Sources that are not fetchable, or
// profiles with no verified source at all, are reported "blocked" - we never
// guess a URL or a semantics change.

import { createHash, randomUUID } from "node:crypto";
import type { AgentId } from "./compat.ts";
import type { EvidenceRegistry } from "./evidenceRegistry.ts";

export type CheckStatus =
	| "unchanged"
	| "changed"
	| "unreachable"
	| "no-baseline"
	| "blocked";

export interface SourceCheck {
	agent: AgentId;
	url: string;
	status: CheckStatus;
	previousHash: string;
	currentHash: string;
	fetchedAt: string;
	note: string;
	/** short sample of newly fetched content (changed sources only), for review. */
	sample?: string;
}

export interface RegistryProposal {
	id: string;
	createdAt: string;
	createdBy: "scheduled-check" | "manual-check";
	baseRegistryVersion: string;
	status: "pending" | "approved";
	checks: SourceCheck[];
	changedCount: number;
	unreachableCount: number;
	blockedCount: number;
	summary: string;
}

export interface FetchResult {
	ok: boolean;
	text?: string;
}

const SAMPLE_LIMIT = 200;

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function isFetchableUrl(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

/** Pure: turn a single fetch outcome into a check against the recorded hash. */
export function classifySource(
	previousHash: string,
	fetch: FetchResult,
	fetchedAt: string,
): { status: CheckStatus; currentHash: string; note: string } {
	if (!fetch.ok) {
		return {
			status: "unreachable",
			currentHash: "",
			note: "source could not be fetched - evidence left unchanged, review manually",
		};
	}
	const text = fetch.text ?? "";
	const currentHash = sha(text);
	if (!previousHash) {
		return {
			status: "no-baseline",
			currentHash,
			note: "first observation - content hash recorded as the new baseline",
		};
	}
	if (previousHash !== currentHash) {
		return {
			status: "changed",
			currentHash,
			note: "source content changed since the last observation - profile evidence may be stale; review required",
		};
	}
	return {
		status: "unchanged",
		currentHash,
		note: "source content matches the recorded evidence",
	};
}

export interface CheckOptions {
	createdBy: "scheduled-check" | "manual-check";
	id?: string;
	now?: Date;
}

/**
 * Run the official-source check over the active registry and build a proposal.
 * `fetchFn` is injectable so tests never touch the network; the default uses
 * the global fetch with a bounded timeout.
 */
export async function checkRegistrySources(
	registry: EvidenceRegistry,
	fetchFn: (url: string) => Promise<FetchResult>,
	options: CheckOptions,
): Promise<RegistryProposal> {
	const now = options.now ?? new Date();
	const fetchedAt = now.toISOString();
	const checks: SourceCheck[] = [];

	for (const [agentId, profile] of Object.entries(registry.profiles)) {
		const agent = agentId as AgentId;
		const fetchable = profile.sources.filter(
			(source) => source.fetchable && isFetchableUrl(source.url),
		);
		if (fetchable.length === 0) {
			checks.push({
				agent,
				url: "",
				status: "blocked",
				previousHash: "",
				currentHash: "",
				fetchedAt,
				note: profile.sources.length
					? "sources are pinned but not fetchable from a public URL - review manually"
					: "no verified official source recorded - evidence is inferred/unknown; blocked rather than guessed",
			});
			continue;
		}
		for (const source of fetchable) {
			let fetch: FetchResult;
			try {
				fetch = await fetchFn(source.url);
			} catch {
				fetch = { ok: false };
			}
			const classified = classifySource(
				source.contentHash,
				fetch,
				fetchedAt,
			);
			checks.push({
				agent,
				url: source.url,
				status: classified.status,
				previousHash: source.contentHash,
				currentHash: classified.currentHash,
				fetchedAt,
				note: classified.note,
				...(classified.status === "changed"
					? { sample: (fetch.text ?? "").slice(0, SAMPLE_LIMIT) }
					: {}),
			});
		}
	}

	const changedCount = checks.filter((c) => c.status === "changed").length;
	const unreachableCount = checks.filter(
		(c) => c.status === "unreachable",
	).length;
	const blockedCount = checks.filter((c) => c.status === "blocked").length;

	const summary =
		changedCount > 0
			? `${changedCount} source(s) changed, ${unreachableCount} unreachable, ${blockedCount} blocked - review required before approval`
			: `no source changed (${unreachableCount} unreachable, ${blockedCount} blocked)`;

	return {
		id: options.id ?? randomUUID(),
		createdAt: now.toISOString(),
		createdBy: options.createdBy,
		baseRegistryVersion: registry.registryVersion,
		status: "pending",
		checks,
		changedCount,
		unreachableCount,
		blockedCount,
		summary,
	};
}

/** Bounded default fetcher used by the server (not by tests). */
export async function fetchSourceContent(url: string): Promise<FetchResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);
	try {
		const response = await fetch(url, {
			headers: { "User-Agent": "skill-manager" },
			signal: controller.signal,
		});
		if (!response.ok) return { ok: false };
		const text = await response.text();
		return { ok: true, text };
	} catch {
		return { ok: false };
	} finally {
		clearTimeout(timer);
	}
}
