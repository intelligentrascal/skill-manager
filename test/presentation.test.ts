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
	// whitespace and single/double quoting, but not a brittle literal match.
	assert.match(html, /let\s+appMode\s*=\s*["']fleet["']/);
});

test("README leads with product outcome, quick start, and safety model", () => {
	assert.match(readme, /^## QUICK START/m);
	assert.match(readme, /^## SAFETY MODEL/m);
	assert.doesNotMatch(readme, /^\*\*[0-9,]+ skills/m);
});
