import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync("src/public/index.html", "utf8");
const readme = readFileSync("README.md", "utf8");

test("dashboard exposes fleet browse and attention without removing existing evidence surfaces", () => {
	for (const marker of [
		'data-app-mode="fleet"',
		'id="fleetModeBtn"',
		'id="browseModeBtn"',
		'id="attentionModeBtn"',
		'id="genomeWall"',
		'id="matrix"',
		'id="rows"',
		'id="healthItems"',
	])
		assert.ok(html.includes(marker), `missing marker: ${marker}`);

	// appMode must be declared and initialized to fleet - tolerant of
	// whitespace, with matching single/double quotes via a backreference.
	assert.match(html, /let\s+appMode\s*=\s*(["'])fleet\1/);

	// Browse mode hides the health queue (CSS selector + render state), and
	// the Attention empty state stays honest about what the queue represents.
	assert.ok(
		html.includes('.wrap[data-app-mode="browse"] .health'),
		"missing browse health-exclusion selector",
	);
	assert.ok(
		html.includes("No drift or uncommitted repo copies are queued."),
		"missing honest attention empty-state sentence",
	);
});

test("README leads with product outcome, quick start, and safety model", () => {
	assert.match(readme, /^## QUICK START$/m);
	assert.match(readme, /^## SAFETY MODEL$/m);
	assert.doesNotMatch(readme, /^\*\*[0-9,]+\s+skills/im);
});

test("inline dashboard script compiles without syntax errors", () => {
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
	assert.ok(scripts.length > 0, "expected an inline <script> block");
	for (const match of scripts) {
		// new Function compiles the body without executing it, so a syntax
		// error in the dashboard script fails here while dashboard code is
		// never run and no files are created.
		assert.doesNotThrow(
			() => new Function(match[1]),
			"inline dashboard script has a syntax error",
		);
	}
});
