// Per-skill upstream freshness check (issue #9 / ticket t-0002).
//
// After a verified public GitHub origin is assigned, the skill pane can pull
// the current upstream state on demand and report honestly: up to date /
// update available / drifted / unreachable - never silently.
//
// Boundaries (spec/SPEC-INTENT.md):
// - No new git-fetch mechanism: pinned-revision content reuses
//   `GitUpstreamUpdateService.fetchSnapshot`; "did upstream move" is a HEAD
//   resolution (`resolveHead`) against the same remote.
// - No auto-advance of the pinned revision: an "update available" report only
//   surfaces the explicit re-pin + update path; review/apply then run against
//   the newly pinned revision.
// - An unreachable upstream is reported as such with the error surfaced; it is
//   never folded into "up to date".
//
// The fetch boundary is injectable so the unreachable case is testable via a
// mocked fetch failure (spec: "The unreachable case must be tested via a
// mocked fetch failure").

import { snapshotDirectory } from "./updates.ts";
import type { SkillSnapshot, UpstreamSource } from "./update.ts";
import { parseGithubUrl } from "./origin.ts";

export type FreshnessState =
	| "up-to-date"
	| "update-available"
	| "drifted"
	| "unreachable";

export interface FreshnessReport {
	skill: string;
	state: FreshnessState;
	/** Display name of the source repository, e.g. "acme/skills". */
	sourceRepo: string | null;
	pinnedRevision: string;
	/** Resolved upstream HEAD; null when it could not be resolved. */
	upstreamHead: string | null;
	checkedAt: string;
	/** Surfaced fetch/read error; non-null only when state is unreachable. */
	error: string | null;
}

/** The two primitives freshness needs: pinned content + a HEAD resolution. */
export interface FreshnessFetch {
	fetchSnapshot(
		source: UpstreamSource,
		revision: string,
	): Promise<SkillSnapshot>;
	resolveHead(url: string): Promise<string>;
}

export interface FreshnessInput {
	skill: string;
	source: UpstreamSource;
	/** The local repo copy directory of the skill (the canonical copy). */
	localSkillDir: string;
	now?: Date;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Compare two skill snapshots by file set (path + executable bit + content).
 * Content comparison is line-ending agnostic for text files: git's
 * core.autocrlf converts LF<->CRLF in working trees, so a fetch checkout may
 * carry CRLF where the committed local copy carries LF (or vice versa). The
 * freshness check reports CONTENT drift - a line-ending-only difference is
 * the same content, not a divergence from the pinned revision.
 */
function contentSignature(file: {
	sha: string;
	content?: string;
}): string {
	return typeof file.content === "string"
		? file.content.replace(/\r\n/g, "\n")
		: file.sha;
}

function sameContent(a: SkillSnapshot, b: SkillSnapshot): boolean {
	if (a.files.length !== b.files.length) return false;
	for (let i = 0; i < a.files.length; i++) {
		const left = a.files[i];
		const right = b.files[i];
		if (
			left.path !== right.path ||
			left.executable !== right.executable ||
			contentSignature(left) !== contentSignature(right)
		) {
			return false;
		}
	}
	return true;
}

/**
 * The repo name a report should show: "owner/repo" for a github.com URL; for
 * any other URL (e.g. a local mock remote) the last two path segments are the
 * best honest identifier. Never a bare, repo-less label.
 */
export function sourceRepoDisplayName(url: string): string | null {
	const parsed = parseGithubUrl(url);
	if (parsed.ok) return `${parsed.ref.owner}/${parsed.ref.repo}`;
	const cleaned = url
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
	const segments = cleaned.split("/").filter(Boolean);
	if (segments.length >= 2) return segments.slice(-2).join("/");
	return segments.length === 1 ? segments[0] : null;
}

/**
 * The honest freshness check. Order matters: a failed HEAD resolution or a
 * failed pinned-revision fetch is reported as unreachable with the error
 * surfaced; a local copy that differs from the pinned revision is reported as
 * drifted (never folded into "up to date"); only when local matches the pin
 * does the upstream HEAD decide between up-to-date and update-available.
 */
export class FreshnessService {
	private readonly fetch: FreshnessFetch;

	constructor(fetch: FreshnessFetch) {
		this.fetch = fetch;
	}

	async check(input: FreshnessInput): Promise<FreshnessReport> {
		const base = {
			skill: input.skill,
			sourceRepo: sourceRepoDisplayName(input.source.url),
			pinnedRevision: input.source.pinnedRevision,
			checkedAt: (input.now ?? new Date()).toISOString(),
		};

		let upstreamHead: string | null;
		try {
			upstreamHead = await this.fetch.resolveHead(input.source.url);
		} catch (error) {
			return {
				...base,
				state: "unreachable",
				upstreamHead: null,
				error: errorMessage(error),
			};
		}

		let pinned: SkillSnapshot;
		try {
			pinned = await this.fetch.fetchSnapshot(
				input.source,
				input.source.pinnedRevision,
			);
		} catch (error) {
			return {
				...base,
				state: "unreachable",
				upstreamHead,
				error: errorMessage(error),
			};
		}

		let local: SkillSnapshot;
		try {
			local = snapshotDirectory(input.localSkillDir, "local");
		} catch (error) {
			return {
				...base,
				state: "unreachable",
				upstreamHead,
				error: `Unable to read the local repo copy: ${errorMessage(error)}`,
			};
		}

		const localMatchesPin = sameContent(local, pinned);
		const upstreamMoved = upstreamHead !== input.source.pinnedRevision;
		const state: FreshnessState = localMatchesPin
			? upstreamMoved
				? "update-available"
				: "up-to-date"
			: "drifted";
		return { ...base, state, upstreamHead, error: null };
	}
}
