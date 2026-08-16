import assert from "node:assert/strict";
import test from "node:test";
import {
	containsCredentials,
	initialOriginRecord,
	normalizeSubpath,
	originState,
	parseGithubUrl,
	provenanceForOrigin,
	reassignOrigin,
	summarizeOrigin,
	validateOriginInput,
} from "../src/origin.ts";

const NOW = "2026-08-16T15:43:00.000Z";

test("parseGithubUrl accepts clean github URLs and rejects non-github hosts", () => {
	const ok = parseGithubUrl("https://github.com/acme/skills.git");
	assert.equal(ok.ok, true);
	if (ok.ok) {
		assert.deepEqual(ok.ref, {
			owner: "acme",
			repo: "skills",
			cloneUrl: "https://github.com/acme/skills.git",
		});
	}

	const tree = parseGithubUrl("https://github.com/acme/skills/tree/main/skills/demo");
	assert.equal(tree.ok, true);
	if (tree.ok) assert.equal(tree.ref.repo, "skills");

	assert.equal(parseGithubUrl("https://gitlab.com/acme/skills.git").ok, false);
	assert.equal(parseGithubUrl("http://github.com/acme/skills").ok, false);
	assert.equal(parseGithubUrl("https://github.com/acme").ok, false);
	assert.equal(parseGithubUrl("").ok, false);
});

test("parseGithubUrl and containsCredentials reject credential-bearing URLs", () => {
	assert.equal(containsCredentials("https://user:token@github.com/acme/skills"), true);
	assert.equal(containsCredentials("https://github.com/acme/skills?access_token=abc"), true);
	assert.equal(containsCredentials("https://github.com/acme/skills?invite=abc"), true);
	assert.equal(containsCredentials("https://github.com/acme/invite/abc"), true);
	assert.equal(containsCredentials("https://github.com/acme/skills.git"), false);

	assert.equal(parseGithubUrl("https://user:token@github.com/acme/skills").ok, false);
	assert.equal(parseGithubUrl("https://github.com/acme/skills?token=x").ok, false);
});

test("containsCredentials does not flag benign params that merely contain 'key'", () => {
	// Regression: the old pattern matched any param containing the substring
	// "key", so a harmless ?monkey=1 was rejected as a credential.
	assert.equal(
		containsCredentials("https://github.com/acme/skills?monkey=1"),
		false,
	);
	assert.equal(
		containsCredentials("https://github.com/acme/skills?hockey=2&turkey=3"),
		false,
	);
	// Whole-name-component credential params are still caught.
	assert.equal(containsCredentials("https://github.com/acme/skills?key=1"), true);
	assert.equal(
		containsCredentials("https://github.com/acme/skills?api_key=1"),
		true,
	);
	assert.equal(
		containsCredentials("https://github.com/acme/skills?private_token=1"),
		true,
	);
});

test("normalizeSubpath rejects escapes and accepts the repository root", () => {
	assert.deepEqual(normalizeSubpath("skills/demo"), { ok: true, subpath: "skills/demo" });
	assert.deepEqual(normalizeSubpath("."), { ok: true, subpath: "." });
	assert.deepEqual(normalizeSubpath("./skills/demo/"), { ok: true, subpath: "skills/demo" });
	assert.deepEqual(normalizeSubpath("skills\\demo"), { ok: true, subpath: "skills/demo" });
	assert.equal(normalizeSubpath("../skills").ok, false);
	assert.equal(normalizeSubpath("/skills/demo").ok, false);
	assert.equal(normalizeSubpath("").ok, false);
});

test("github origin validates repository and subpath, and never keeps an inline URL", () => {
	const result = validateOriginInput(
		{
			type: "github",
			reason: "imported from upstream",
			url: "https://github.com/acme/skills.git",
			subpath: "skills/demo",
		},
		NOW,
	);
	assert.equal(result.ok, true);
	assert.ok(result.assignment);
	assert.equal(result.assignment!.type, "github");
	assert.equal(result.assignment!.url, undefined);
	assert.ok(result.github);
	assert.equal(result.github!.ref.owner, "acme");
	assert.equal(result.github!.subpath, "skills/demo");

	const bad = validateOriginInput(
		{ type: "github", reason: "x", url: "https://gitlab.com/a/b", subpath: "s" },
		NOW,
	);
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.some((e) => /github\.com/.test(e)));
});

test("private origins require attribution and reject credential-bearing URLs", () => {
	const noAttribution = validateOriginInput(
		{ type: "private", reason: "from a community thread" },
		NOW,
	);
	assert.equal(noAttribution.ok, false);
	assert.ok(noAttribution.errors.some((e) => /attribution/.test(e)));

	const ok = validateOriginInput(
		{
			type: "private",
			reason: "from a community thread",
			attribution: "https://community.example.com/thread/42",
		},
		NOW,
	);
	assert.equal(ok.ok, true);
	assert.equal(ok.assignment!.attribution, "https://community.example.com/thread/42");

	const withToken = validateOriginInput(
		{
			type: "private",
			reason: "x",
			attribution: "community thread",
			url: "https://gitlab.com/acme/skills?private_token=abc",
		},
		NOW,
	);
	assert.equal(withToken.ok, false);
	assert.ok(withToken.errors.some((e) => /credentials/.test(e)));
});

test("local origins allow an ownership note but no external source", () => {
	const ok = validateOriginInput(
		{ type: "local", reason: "I wrote this", ownershipNote: "my scratch skill" },
		NOW,
	);
	assert.equal(ok.ok, true);
	assert.equal(ok.assignment!.ownershipNote, "my scratch skill");
	assert.equal(ok.assignment!.url, undefined);

	const withUrl = validateOriginInput(
		{ type: "local", reason: "x", url: "https://github.com/acme/skills" },
		NOW,
	);
	assert.equal(withUrl.ok, false);
});

test("originState is honest: unknown without a record, private/local never github", () => {
	assert.equal(originState(undefined), "unknown");
	const github = validateOriginInput(
		{ type: "github", reason: "r", url: "https://github.com/a/b.git", subpath: "s" },
		NOW,
	).assignment!;
	assert.equal(originState(initialOriginRecord(github)), "github");

	const priv = validateOriginInput(
		{ type: "private", reason: "r", attribution: "a" },
		NOW,
	).assignment!;
	assert.equal(originState(initialOriginRecord(priv)), "private");
});

test("reassignment is append-only and preserves prior origins in history", () => {
	const first = validateOriginInput(
		{ type: "private", reason: "found in a gist", attribution: "gist" },
		NOW,
	).assignment!;
	const second = validateOriginInput(
		{ type: "github", reason: "upstream located", url: "https://github.com/a/b.git", subpath: "s" },
		NOW,
	).assignment!;
	const record = reassignOrigin(initialOriginRecord(first), second);
	assert.equal(record.current.type, "github");
	assert.equal(record.history.length, 1);
	assert.equal(record.history[0].type, "private");
	assert.equal(record.history[0].attribution, "gist");
});

test("provenanceForOrigin maps github/private to upstream and local to mine", () => {
	const github = validateOriginInput(
		{ type: "github", reason: "r", url: "https://github.com/a/b.git", subpath: "s" },
		NOW,
	).assignment!;
	const priv = validateOriginInput(
		{ type: "private", reason: "r", attribution: "a" },
		NOW,
	).assignment!;
	const local = validateOriginInput(
		{ type: "local", reason: "r" },
		NOW,
	).assignment!;
	assert.equal(provenanceForOrigin(github), "upstream");
	assert.equal(provenanceForOrigin(priv), "upstream");
	assert.equal(provenanceForOrigin(local), "mine");
});

test("missing reason or type is rejected", () => {
	assert.equal(validateOriginInput({ type: "local", reason: "" }, NOW).ok, false);
	assert.equal(validateOriginInput({ type: "other", reason: "x" }, NOW).ok, false);
	assert.equal(validateOriginInput({ type: "local", reason: "x" }, "not-a-date").ok, false);
});

test("summarizeOrigin never fabricates GitHub facts for private/local/unknown", () => {
	const identity = {
		upstreamUrl: "https://github.com/acme/skills.git",
		subpath: "skills/demo",
		pinnedRevision: "abc123",
	};
	const github = validateOriginInput(
		{ type: "github", reason: "r", url: identity.upstreamUrl, subpath: identity.subpath },
		NOW,
	).assignment!;
	const priv = validateOriginInput(
		{ type: "private", reason: "r", attribution: "community" },
		NOW,
	).assignment!;

	const githubSummary = summarizeOrigin(
		initialOriginRecord(github),
		identity,
		true,
	);
	assert.equal(githubSummary.state, "github");
	assert.deepEqual(githubSummary.identity, identity);

	const privateSummary = summarizeOrigin(
		initialOriginRecord(priv),
		identity,
		true,
	);
	assert.equal(privateSummary.state, "private");
	assert.equal(privateSummary.identity, null);

	const unknownSummary = summarizeOrigin(undefined, undefined, false);
	assert.equal(unknownSummary.state, "unknown");
	assert.equal(unknownSummary.identity, null);
	assert.equal(unknownSummary.managed, false);
});
