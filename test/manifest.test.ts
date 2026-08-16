import assert from "node:assert/strict";
import test from "node:test";
import {
	ManifestValidationError,
	newManifestWithEntry,
	parseManifest,
	serializeSkillEntry,
	upsertSkillEntry,
} from "../src/manifest.ts";

const valid = `
version: 1
skills:
  upstream-skill:
    provenance: upstream
    identity:
      upstreamUrl: https://github.com/example/skills
      subpath: skills/upstream-skill
      pinnedRevision: abc123
    variants:
      - agent: pi
        baseRevision: abc123
        deployedTo: ~/.pi/agent/skills/upstream-skill
        conflict: false
    securityReview:
      state: reviewed
      at: 2026-08-12T12:00:00Z
  local-skill:
    provenance: mine
`;

test("parses the versioned provenance manifest", () => {
	const manifest = parseManifest(valid);
	assert.equal(manifest.version, 1);
	assert.deepEqual(manifest.skills["upstream-skill"], {
		provenance: "upstream",
		identity: {
			upstreamUrl: "https://github.com/example/skills",
			subpath: "skills/upstream-skill",
			pinnedRevision: "abc123",
		},
		variants: [
			{
				agent: "pi",
				baseRevision: "abc123",
				deployedTo: "~/.pi/agent/skills/upstream-skill",
				conflict: false,
			},
		],
		securityReview: { state: "reviewed", at: "2026-08-12T12:00:00Z" },
	});
	assert.deepEqual(manifest.skills["local-skill"], { provenance: "mine" });
});

test("requires identity for managed upstream mirrors", () => {
	assert.throws(
		() =>
			parseManifest(
				"version: 1\nskills:\n  orphan:\n    provenance: upstream\n",
			),
		(error: unknown) =>
			error instanceof ManifestValidationError &&
			/identity is required/.test(error.message),
	);
});

test("rejects unsafe or ambiguous records", () => {
	assert.throws(
		() => parseManifest("version: 2\nskills: {}\n"),
		ManifestValidationError,
	);
	assert.throws(
		() =>
			parseManifest(
				"version: 1\nskills:\n  mine:\n    provenance: mine\n    source: guess\n",
			),
		(error: unknown) =>
			error instanceof ManifestValidationError &&
			/supported field/.test(error.message),
	);
	assert.throws(
		() =>
			parseManifest(
				"version: 1\nskills:\n  mine:\n    provenance: mine\n    variants:\n      - agent: pi\n        baseRevision: one\n        deployedTo: one\n      - agent: pi\n        baseRevision: two\n        deployedTo: two\n",
			),
		/duplicates pi/,
	);
});

test("parses an origin record with current + append-only history", () => {
	const manifest = parseManifest(`
version: 1
skills:
  migrated:
    provenance: upstream
    identity:
      upstreamUrl: https://github.com/acme/skills.git
      subpath: skills/migrated
      pinnedRevision: abc123
    origin:
      current:
        type: github
        at: 2026-08-16T15:43:00.000Z
        reason: upstream located
        verifiedAt: 2026-08-16T15:43:00.000Z
      history:
        - type: private
          at: 2026-08-15T00:00:00.000Z
          reason: found in a gist
          attribution: community gist
`);
	const record = manifest.skills["migrated"];
	assert.ok(record.origin);
	assert.equal(record.origin!.current.type, "github");
	assert.equal(record.origin!.history.length, 1);
	assert.equal(record.origin!.history[0].type, "private");
	assert.equal(record.origin!.history[0].attribution, "community gist");
});

test("private origins do not require an identity (unverified state)", () => {
	const manifest = parseManifest(`
version: 1
skills:
  community:
    provenance: upstream
    origin:
      current:
        type: private
        at: 2026-08-16T15:43:00.000Z
        reason: from a community thread
        attribution: https://community.example.com/thread/42
`);
	assert.equal(manifest.skills["community"].identity, undefined);
	assert.equal(manifest.skills["community"].origin!.current.type, "private");
});

test("origin entries with credentials or invalid types are rejected", () => {
	assert.throws(
		() =>
			parseManifest(
				"version: 1\nskills:\n  x:\n    provenance: mine\n    origin:\n      current:\n        type: private\n        at: 2026-08-16T00:00:00Z\n        reason: r\n        url: https://h/p?token=abc\n",
			),
		/credentials/,
	);
	assert.throws(
		() =>
			parseManifest(
				"version: 1\nskills:\n  x:\n    provenance: mine\n    origin:\n      current:\n        type: magic\n        at: 2026-08-16T00:00:00Z\n        reason: r\n",
			),
		/type is invalid/,
	);
});

test("serializeSkillEntry round-trips through parseManifest", () => {
	const record = {
		provenance: "upstream" as const,
		identity: {
			upstreamUrl: "https://github.com/acme/skills.git",
			subpath: "skills/demo",
			pinnedRevision: "abc123",
		},
		origin: {
			current: {
				type: "github" as const,
				at: "2026-08-16T15:43:00.000Z",
				reason: "imported from upstream",
				verifiedAt: "2026-08-16T15:43:00.000Z",
			},
			history: [
				{
					type: "private" as const,
					at: "2026-08-15T00:00:00.000Z",
					reason: "found in a gist",
					attribution: "a gist",
				},
			],
		},
	};
	const text = newManifestWithEntry("demo", record);
	const parsed = parseManifest(text);
	assert.deepEqual(parsed.skills["demo"], record);
});

test("upsertSkillEntry appends a new skill and replaces an existing one", () => {
	const original = "# header\nversion: 1\nskills:\n  alpha:\n    provenance: mine\n";
	const record = {
		provenance: "mine" as const,
		origin: {
			current: {
				type: "local" as const,
				at: "2026-08-16T15:43:00.000Z",
				reason: "I wrote this",
				ownershipNote: "scratch",
			},
			history: [],
		},
	};
	const appended = upsertSkillEntry(original, "beta", record);
	assert.ok(appended.includes("# header"));
	assert.ok(appended.includes("  alpha:"));
	assert.ok(appended.includes("  beta:"));
	assert.equal(parseManifest(appended).skills["beta"].origin!.current.type, "local");

	const replaced = upsertSkillEntry(original, "alpha", record);
	assert.ok(replaced.includes("type: local"));
	assert.ok(replaced.includes("ownershipNote: scratch"));
	assert.equal(replaced.split("  alpha:").length - 1, 1);
	assert.equal(parseManifest(replaced).skills["alpha"].origin!.current.type, "local");
	assert.equal(parseManifest(replaced).skills["beta"], undefined);
});

test("serializeSkillEntry emits a valid version-1 block", () => {
	const record = {
		provenance: "mine" as const,
	};
	const block = serializeSkillEntry("demo", record);
	assert.ok(block.startsWith("  demo:"));
	assert.ok(block.includes("    provenance: mine"));
});
