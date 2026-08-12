import assert from "node:assert/strict";
import test from "node:test";
import { renderSnapshot } from "../src/snapshot.ts";

test("renders a standalone inventory summary", () => {
	const html = renderSnapshot({
		generatedAt: "2026-08-12T00:00:00.000Z",
		stats: {
			totalSkills: 1,
			totalCopies: 1,
			drift: 0,
			duplicate: 0,
			unique: 1,
		},
		byName: {
			hallmark: [
				{
					location: "pi",
					sha: "abc",
					description: "Make interfaces distinctive.",
				},
			],
		},
	});

	assert.match(html, /^<!doctype html>/i);
	assert.match(html, /<b>1<\/b> skills/);
	assert.match(html, /hallmark/);
	assert.doesNotMatch(html, /https?:\/\//);
});

test("escapes skill content in a static snapshot", () => {
	const html = renderSnapshot({
		generatedAt: "2026-08-12T00:00:00.000Z",
		stats: {
			totalSkills: 1,
			totalCopies: 1,
			drift: 0,
			duplicate: 0,
			unique: 1,
		},
		byName: {
			"<skill>": [
				{
					location: "pi",
					sha: "abc",
					description: "<script>alert(1)</script>",
				},
			],
		},
	});

	assert.match(html, /&lt;skill&gt;/);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});
