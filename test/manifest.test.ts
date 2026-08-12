import assert from "node:assert/strict";
import test from "node:test";
import { ManifestValidationError, parseManifest } from "../src/manifest.ts";

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
