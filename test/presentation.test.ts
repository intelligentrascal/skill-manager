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
		'let appMode = "fleet"',
		'id="genomeWall"',
		'id="matrix"',
		'id="rows"',
		'id="healthItems"',
	])
		assert.match(
			html,
			new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
});

test("README leads with product outcome, quick start, and safety model", () => {
	assert.match(readme, /## QUICK START/);
	assert.match(readme, /## SAFETY MODEL/);
	assert.doesNotMatch(readme, /\*\*258 skills/);
});
