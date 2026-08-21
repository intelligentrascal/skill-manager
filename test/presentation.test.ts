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

test("agent variant matrix is honest, accessible, and stacked with the detail workspace", () => {
	for (const marker of [
		'id="variantMatrix"',
		'id="variantMatrixTitle"',
		'id="variantMatrixBody"',
		'aria-labelledby="variantMatrixTitle"',
		"Canonical",
		"Variant stored",
		"Deployed",
		"Verified",
		"Unknown",
		"/api/variant-matrix",
	]) {
		assert.ok(html.includes(marker), `missing agent variant matrix contract: ${marker}`);
	}
	assert.ok(html.includes("Absent variant data stays Unknown"));
	assert.ok(html.includes("Review adaptation"), "the variant matrix offers the Adaptation Review action");
	assert.ok(html.includes("adapt-blocking"), "blocking conditions are rendered in coral");
	assert.doesNotMatch(html, /edit variant/i);
	assert.match(html, /@media \(max-width: 900px\)[\s\S]*?\.detail-grid\s*{[\s\S]*?grid-template-columns:\s*1fr/);
	assert.match(html, /\.variant-diff[\s\S]*?overflow-wrap:\s*anywhere/);
});

test("variant review button propagates the skill it was rendered for", () => {
	const render = html.match(
		/function renderVariantMatrix\(matrix, mount\) \{[\s\S]*?\n      \}/,
	)?.[0];
	assert.ok(render, "expected renderVariantMatrix function body");
	// The click handler must send the skill the matrix was rendered for -
	// never a bare `name` identifier (which resolves to window.name = "").
	assert.match(
		render,
		/reviewAdaptation\(matrix\?\.skill/,
		"review handler must read the skill name from the matrix",
	);
	assert.doesNotMatch(
		render,
		/reviewAdaptation\(\s*name\s*,/,
		"review handler must not close over an undefined `name`",
	);
	assert.doesNotMatch(
		render,
		/window\.name/,
		"review handler must not resolve the page window name",
	);
});

test("unknown variant rows explain why and offer creation when supported", () => {
	// Every Unknown row explains its reason instead of a bare status, and
	// offers a create action gated on the row's createSupported flag.
	assert.ok(
		html.includes("Create variant"),
		"missing create-variant affordance label",
	);
	assert.match(
		html,
		/row\.createSupported/,
		"create affordance must be gated on row.createSupported",
	);
	assert.match(
		html,
		/row\.reason/,
		"unknown-row explanation must render the row reason",
	);
	assert.ok(
		html.includes("/api/variant"),
		"create action must post to /api/variant",
	);
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

/** Extract a top-level function body by name from the inline dashboard script. */
function extractFunction(source: string, name: string): string {
	const marker = `function ${name}(`;
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `missing function ${name}`);
	let depth = 0;
	let i = start;
	for (; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) {
				i++;
				break;
			}
		}
	}
	return source.slice(start, i);
}

test("origin assignment dialog prefills subpath from the skill's known location and needs no hand-typed path", () => {
	// The reason field is no longer required for any origin type at the form
	// level; enforcement is type-dependent on the server.
	assert.doesNotMatch(html, /reason\.required\s*=\s*true/);
	// The github branch builds a subpath from the known location and offers an
	// explicit auto-assign action.
	assert.ok(html.includes("Auto-assign path"), "missing explicit auto-assign skill-path action");
	assert.ok(html.includes("knownSkillSubpath(skillData)"), "missing known-location subpath wiring");
	assert.ok(
		/knownSkillSubpath\(skillData\)/.test(html),
		"subpath defaults are derived from the skill's known location",
	);
	// The submit path falls back to the known location, so submitting without a
	// hand-typed path is possible.
	assert.ok(html.includes("knownSkillSubpath(skillData)"), "submit falls back to the known location");
});

test("knownSkillSubpath derives the repo subpath and falls back to the directory name", () => {
	const fn = new Function("return (" + extractFunction(html, "knownSkillSubpath") + ")")();
	// Repo copy path wins: skills/<category>/<name> under the repo's skills root.
	assert.equal(
		fn({
			copies: [
				{ location: "pi", path: "C:/Users/x/.pi/agent/skills/Curet1fa/SKILL.md" },
				{ location: "repo", path: "D:/agent-skills/skills/misc/Curet1fa/SKILL.md" },
			],
		}),
		"skills/misc/Curet1fa",
	);
	// Windows-style backslashes normalize the same way.
	assert.equal(
		fn({ copies: [{ location: "repo", path: "D:\\agent-skills\\skills\\core\\demo\\SKILL.md" }] }),
		"skills/core/demo",
	);
	// Without a repo copy, the directory name of the first discovered copy is used.
	assert.equal(
		fn({ copies: [{ location: "pi", path: "/home/x/.pi/agent/skills/DemoSkill/SKILL.md" }] }),
		"skills/DemoSkill",
	);
	assert.equal(fn({ copies: [] }), "");
	assert.equal(fn(null), "");
});

test("assignment preview surfaces the verified skill name before confirm", () => {
	assert.ok(
		html.includes("Verified skill name"),
		"the preview names the verified skill name before the user confirms",
	);
	assert.ok(
		html.includes("record key stays"),
		"the preview states that the manifest key is not renamed",
	);
});

test("origin history tolerates assignments recorded without a reason", () => {
	assert.match(html, /\(entry\.reason \|\| [^)]+\)/);
});
