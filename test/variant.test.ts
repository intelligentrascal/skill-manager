import assert from "node:assert/strict";
import test from "node:test";
import { adaptSkill, verifyAdaptation } from "../src/variant.ts";

const CLAUDE_SKILL = `---
name: review
description: Review code for bugs and quality.
argument-hint: "usage: review <path>"
user-invocable: true
allowed-tools: Read, Grep, Bash
---

## Workflow

Review the code.
`;

test("pi variant drops claude invocation fields, keeps allowed-tools", () => {
	const r = adaptSkill(CLAUDE_SKILL, "pi");
	assert.deepEqual(r.removed.sort(), ["argument-hint", "user-invocable"]);
	assert.ok(!r.content.includes("argument-hint"));
	assert.ok(!r.content.includes("user-invocable"));
	// allowed-tools is kept for pi (documented: pi honors it experimentally)
	assert.ok(r.content.includes("allowed-tools"));
	// the dropped guidance is reported honestly
	assert.ok(r.carryOver.some((c) => c.includes("invocation fields")));
});

test("opencode variant adds a triggers hint", () => {
	const r = adaptSkill(CLAUDE_SKILL, "opencode");
	assert.ok(r.added.includes("triggers"));
	assert.ok(r.content.includes("triggers: auto"));
	assert.ok(!r.content.includes("user-invocable"));
});

test("codex variant drops invocation fields, keeps allowed-tools (profile says honored)", () => {
	const r = adaptSkill(CLAUDE_SKILL, "codex");
	assert.ok(!r.content.includes("argument-hint"));
	assert.ok(!r.content.includes("user-invocable"));
	// codex profile (inferred) marks allowed-tools as honored - the variant
	// must stay consistent with the compat engine, not invent drops
	assert.ok(r.content.includes("allowed-tools"));
});

test("claude target is unchanged (no adaptation needed)", () => {
	const r = adaptSkill(CLAUDE_SKILL, "claude");
	assert.deepEqual(r.removed, []);
	assert.equal(r.content, CLAUDE_SKILL);
});

test("carry-over detection: scripts and mcp are flagged, never dropped", () => {
	const withScripts = `---
name: x
description: does things
---

Run scripts/deploy.sh.

MCP server required: playwright
`;
	const r = adaptSkill(withScripts, "pi");
	assert.ok(r.carryOver.some((c) => c.includes("scripts/")));
	assert.ok(r.carryOver.some((c) => c.includes("MCP")));
	assert.ok(r.content.includes("scripts/deploy.sh"), "content preserved");
});

test("no frontmatter block blocks adaptation honestly", () => {
	const r = adaptSkill("# just a heading\n\nno frontmatter here", "pi");
	assert.ok(r.blocked);
	assert.equal(r.content, "# just a heading\n\nno frontmatter here");
});

test("multi-line frontmatter values are preserved", () => {
	const multi = `---
name: x
description: |
  a multi-line
  description
---

body
`;
	const r = adaptSkill(multi, "codex");
	assert.ok(r.content.includes("a multi-line"), "description kept");
	assert.ok(r.content.includes("description: |"), "block scalar kept");
});

test("verifyAdaptation: removed fields are gone; pi keeps allowed-tools by design", () => {
	const v1 = verifyAdaptation(
		["name", "description", "allowed-tools"],
		["argument-hint", "user-invocable"],
		"pi",
	);
	assert.equal(v1.ok, true);

	const v2 = verifyAdaptation(
		["name", "description", "user-invocable"],
		["user-invocable"],
		"codex",
	);
	assert.equal(v2.ok, false);
	assert.deepEqual(v2.stillPresent, ["user-invocable"]);
});
