// Canonical skill origins: the evidence-backed model for where a managed skill
// came from. Three assignable origin types plus an honest "unknown" state.
//
// Honesty contract (from the provenance design):
// - A public GitHub origin is verified: repository + exact SKILL.md subpath are
//   validated, then a revision is pinned. It is the only origin that may carry
//   GitHub owner/repository facts.
// - A private/community origin is explicitly UNVERIFIED. It requires an
//   attribution note, rejects any URL carrying credentials or invite tokens,
//   and must never be presented with GitHub stars, owner facts, or a pinned
//   revision.
// - A mine/local origin has no claimed external upstream and carries at most an
//   optional ownership note.
// - An origin change is append-only: the current origin is prominent while prior
//   origins retain timestamp, reason, and attribution in history.
//
// This module is pure: no filesystem or network access, so every rule is a
// direct unit-test seam.

export type OriginType = "github" | "private" | "local";
export type OriginState = OriginType | "unknown";

/** One origin assignment: a single entry in the append-only history. */
export interface OriginAssignment {
	type: OriginType;
	/** ISO timestamp of the assignment (set by the app, never the client). */
	at: string;
	/** Why this origin was assigned. Required for every assignment. */
	reason: string;
	/** Required for private/community origins. */
	attribution?: string;
	/** Optional note for mine/local origins. */
	ownershipNote?: string;
	/** Private/community: optional credential-free source URL. */
	url?: string;
	/** Private/community: optional exact SKILL.md subpath within the source. */
	subpath?: string;
	/** GitHub: when the repository + subpath were last verified. */
	verifiedAt?: string;
}

/** The current origin plus the append-only history of prior origins. */
export interface OriginRecord {
	current: OriginAssignment;
	/** Prior assignments, oldest first. The current entry is not repeated here. */
	history: OriginAssignment[];
}

/** Raw client input for an origin assignment (no timestamp). */
export interface OriginInput {
	type: string;
	reason: string;
	attribution?: string;
	ownershipNote?: string;
	url?: string;
	subpath?: string;
}

export interface GithubRepoRef {
	owner: string;
	repo: string;
	/** Canonical clone URL, e.g. https://github.com/<owner>/<repo>.git */
	cloneUrl: string;
}

export interface OriginValidationResult {
	ok: boolean;
	errors: string[];
	assignment?: OriginAssignment;
	/** Populated only when a valid GitHub origin is provided. */
	github?: { ref: GithubRepoRef; subpath: string };
}

const GITHUB_OWNER = /^[A-Za-z0-9-]+$/;
const GITHUB_REPO = /^[A-Za-z0-9_.-]+$/;

/** Invite links in the path must never be persisted. */
const INVITE_PATH_PATTERN = /\/(?:invite|invitations)\/[^/?#]+/i;

/**
 * A credential/token query-parameter name, matched as a whole name component so
 * `?access_token=` and `?api-key=` are caught but a benign `?monkey=` (or any
 * name that merely contains "key" as a substring) is not.
 */
const CREDENTIAL_PARAM_PATTERN =
	/(?:^|[_-])(?:token|secret|password|credential|key|auth|invite)(?:$|[_-])/i;

/** True when a URL carries credentials or an invite token and must be rejected. */
export function containsCredentials(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
		if (parsed.username || parsed.password) return true;
	} catch {
		return true; // unparseable URLs are rejected outright
	}
	if (INVITE_PATH_PATTERN.test(url)) return true;
	for (const key of parsed.searchParams.keys()) {
		if (CREDENTIAL_PARAM_PATTERN.test(key)) return true;
	}
	// OAuth implicit flows can stash tokens in the URL fragment.
	const fragment = parsed.hash.replace(/^#/, "");
	if (fragment) {
		for (const pair of fragment.split("&")) {
			const key = (pair.split("=", 1)[0] ?? "").trim();
			if (key && CREDENTIAL_PARAM_PATTERN.test(key)) return true;
		}
	}
	return false;
}

/** Parse a public GitHub repository URL into owner, repo, and a clone URL. */
export function parseGithubUrl(
	url: string,
): { ok: true; ref: GithubRepoRef } | { ok: false; error: string } {
	const trimmed = (url ?? "").trim();
	if (!trimmed) return { ok: false, error: "repository URL is required" };
	if (containsCredentials(trimmed)) {
		return {
			ok: false,
			error: "repository URL must not contain credentials or invite tokens",
		};
	}
	let host = "";
	let path = "";
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "https:") {
			return { ok: false, error: "repository URL must use https" };
		}
		host = parsed.hostname.toLowerCase();
		path = parsed.pathname;
	} catch {
		return { ok: false, error: "repository URL is not a valid URL" };
	}
	if (host !== "github.com") {
		return {
			ok: false,
			error: `repository must be on github.com, got ${host}`,
		};
	}
	const segments = path.split("/").filter(Boolean);
	if (segments.length < 2) {
		return {
			ok: false,
			error: "repository URL must include owner and repository name",
		};
	}
	const owner = segments[0];
	let repo = segments[1].replace(/\.git$/, "");
	// Accept https://github.com/<owner>/<repo>[/tree|blob/<rev>/<subpath>]
	if (!GITHUB_OWNER.test(owner)) {
		return { ok: false, error: `invalid repository owner: ${owner}` };
	}
	if (!GITHUB_REPO.test(repo) || !repo) {
		return { ok: false, error: `invalid repository name: ${repo}` };
	}
	return {
		ok: true,
		ref: { owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` },
	};
}

/** Normalize an exact SKILL.md subpath; "." means the repository root. */
export function normalizeSubpath(
	subpath: string,
): { ok: true; subpath: string } | { ok: false; error: string } {
	const trimmed = (subpath ?? "").trim().replace(/\\/g, "/");
	if (!trimmed) return { ok: false, error: "subpath is required" };
	if (trimmed === "." || trimmed === "./") return { ok: true, subpath: "." };
	if (trimmed.startsWith("/")) {
		return { ok: false, error: "subpath must be relative, not absolute" };
	}
	const parts = trimmed.split("/").filter((p) => p && p !== ".");
	if (parts.some((p) => p === "..")) {
		return { ok: false, error: "subpath must not contain '..' escapes" };
	}
	if (!parts.length) return { ok: true, subpath: "." };
	return { ok: true, subpath: parts.join("/") };
}

function isValidIso(value: string): boolean {
	return typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function nonEmpty(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function hasLineBreak(value: unknown): boolean {
	return typeof value === "string" && /[\r\n]/.test(value);
}

/**
 * Validate a raw origin assignment against the honesty contract. On success the
 * returned assignment carries only the fields its type is allowed to claim:
 * GitHub never keeps an inline URL (that lives in the identity), and
 * private/local never claim GitHub facts.
 */
export function validateOriginInput(
	input: OriginInput,
	at: string,
): OriginValidationResult {
	const errors: string[] = [];
	if (!input || typeof input !== "object") {
		return { ok: false, errors: ["origin assignment is required"] };
	}
	if (!isValidIso(at)) {
		errors.push("assignment timestamp must be a valid ISO date");
	}
	if (!["github", "private", "local"].includes(input.type)) {
		errors.push(
			`origin type must be one of github, private, local (got ${input.type})`,
		);
	}
	if (!nonEmpty(input.reason)) {
		errors.push("a reason for the origin assignment is required");
	}
	if (hasLineBreak(input.reason)) {
		errors.push("reason must be a single line");
	}
	if (hasLineBreak(input.attribution) || hasLineBreak(input.ownershipNote)) {
		errors.push("attribution and ownership notes must be single lines");
	}
	if (errors.length) return { ok: false, errors };

	const base: OriginAssignment = {
		type: input.type as OriginType,
		at,
		reason: input.reason.trim(),
	};

	if (input.type === "github") {
		const urlResult = parseGithubUrl(input.url ?? "");
		if (!urlResult.ok) {
			errors.push(urlResult.error);
			return { ok: false, errors };
		}
		const subpathResult = normalizeSubpath(input.subpath ?? "");
		if (!subpathResult.ok) {
			errors.push(subpathResult.error);
			return { ok: false, errors };
		}
		if (input.attribution !== undefined || input.ownershipNote !== undefined) {
			errors.push(
				"a GitHub origin does not take attribution or ownership notes",
			);
			return { ok: false, errors };
		}
		return {
			ok: true,
			errors: [],
			assignment: base,
			github: { ref: urlResult.ref, subpath: subpathResult.subpath },
		};
	}

	if (input.type === "private") {
		if (!nonEmpty(input.attribution)) {
			errors.push("a private/community origin requires an attribution note");
		}
		if (input.url !== undefined && input.url.trim() !== "") {
			if (containsCredentials(input.url)) {
				errors.push(
					"private origin URL must not contain credentials or invite tokens",
				);
			} else {
				base.url = input.url.trim();
			}
		}
		if (input.subpath !== undefined && input.subpath.trim() !== "") {
			const subpathResult = normalizeSubpath(input.subpath);
			if (!subpathResult.ok) {
				errors.push(subpathResult.error);
			} else {
				base.subpath = subpathResult.subpath;
			}
		}
		if (input.attribution !== undefined && nonEmpty(input.attribution)) {
			base.attribution = input.attribution.trim();
		}
		if (errors.length) return { ok: false, errors };
		return { ok: true, errors: [], assignment: base };
	}

	// local
	if (input.url !== undefined || input.subpath !== undefined) {
		errors.push("a local origin must not claim an external source URL");
	}
	if (input.attribution !== undefined) {
		errors.push("a local origin does not take an attribution note");
	}
	if (errors.length) return { ok: false, errors };
	if (input.ownershipNote !== undefined && input.ownershipNote.trim() !== "") {
		base.ownershipNote = input.ownershipNote.trim();
	}
	return { ok: true, errors: [], assignment: base };
}

/** Create the first origin record for a skill with no prior origin. */
export function initialOriginRecord(assignment: OriginAssignment): OriginRecord {
	return { current: assignment, history: [] };
}

/** Append-only reassignment: the current origin moves into history. */
export function reassignOrigin(
	record: OriginRecord | undefined,
	next: OriginAssignment,
): OriginRecord {
	if (!record) return { current: next, history: [] };
	return { current: next, history: [...record.history, record.current] };
}

/** The honest current origin state, or "unknown" when no origin is recorded. */
export function originState(record: OriginRecord | undefined): OriginState {
	return record?.current?.type ?? "unknown";
}

/** Minimal identity shape used by the API summary (avoids a manifest import). */
export interface OriginIdentitySummary {
	upstreamUrl: string;
	subpath: string;
	pinnedRevision: string;
}

export interface OriginSummary {
	state: OriginState;
	managed: boolean;
	current: OriginAssignment | null;
	history: OriginAssignment[];
	identity: OriginIdentitySummary | null;
}

/**
 * The API-facing origin view. Identity (a GitHub fact) is returned ONLY for a
 * github origin - private, local, and unknown origins never leak or fabricate
 * owner/repo/pinned-revision data.
 */
export function summarizeOrigin(
	record: OriginRecord | undefined,
	identity: OriginIdentitySummary | undefined,
	managed: boolean,
): OriginSummary {
	const state = originState(record);
	return {
		state,
		managed,
		current: record?.current ?? null,
		history: record?.history ?? [],
		identity: state === "github" ? (identity ?? null) : null,
	};
}

/**
 * Derive the coarse provenance value (the pre-existing skillmgr.yaml field)
 * from an origin assignment. GitHub and private both map to "upstream" (a
 * tracked or community upstream); local maps to "mine".
 */
export function provenanceForOrigin(
	assignment: OriginAssignment,
): "upstream" | "mine" {
	return assignment.type === "local" ? "mine" : "upstream";
}
