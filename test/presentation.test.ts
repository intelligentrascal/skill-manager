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

test("skill selection opens an origin-led workspace instead of a drawer", () => {
	for (const marker of [
		'id="inventoryWorkspace"',
		'id="skillWorkspace"',
		'id="skillBackBtn"',
		'id="originHero"',
		'id="skillEvidence"',
		'id="skillOperations"',
	]) {
		assert.ok(html.includes(marker), `missing detail workspace marker: ${marker}`);
	}
	assert.doesNotMatch(html, /id=["']drawer["']/);
	assert.match(html, /data-detail-open/);
	assert.match(html, /aria-labelledby=["']skillWorkspaceTitle["']/);
});

test("origin heroes keep GitHub facts explicit and make unknown assignment primary", () => {
	for (const copy of [
		"Verified GitHub origin",
		"Private / community origin",
		"Mine / local origin",
		"Origin unknown",
		"Assign origin",
		"Refresh GitHub facts",
		"/api/origin/refresh",
	]) {
		assert.ok(html.includes(copy), `missing origin workspace contract: ${copy}`);
	}
	const loadBody = html.match(
		/async function load\([\s\S]*?\n\s*function renderHarnessChips/,
	)?.[0];
	assert.ok(loadBody, "expected to find the page-load function");
	assert.doesNotMatch(loadBody!, /\/api\/origin(?:\/refresh)?/);
});

test("detail workspace declares full-screen responsive Back behavior and reviewed references", () => {
	assert.match(html, /min-height:\s*100dvh/);
	assert.ok(html.includes('key === "Escape"'));
	assert.ok(html.includes("altKey"));
	for (const reference of ["GitHub activity", "Linear project detail", "Graphite activity panel", "GitLab repository page", "Vercel Git settings"]) {
		assert.ok(html.includes(reference), `missing visual reference trace: ${reference}`);
	}
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
