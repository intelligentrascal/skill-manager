import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	FreshnessService,
	sourceRepoDisplayName,
	type FreshnessFetch,
} from "../src/freshness.ts";
import type { SkillSnapshot, UpstreamSource } from "../src/update.ts";

const REV1 = "a".repeat(40);
const REV2 = "b".repeat(40);

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function snapshot(revision: string, content: string): SkillSnapshot {
	return {
		revision,
		files: [
			{
				path: "SKILL.md",
				sha: sha(content),
				bytes: content.length,
				executable: false,
				content,
			},
		],
	};
}

const SOURCE: UpstreamSource = {
	url: "https://github.com/acme/skills.git",
	subpath: "skills/example-skill",
	pinnedRevision: REV1,
};

/** Fake fetch boundary - the unreachable case is a mocked fetch failure. */
function fakeFetch(options: {
	head?: string;
	pinned?: SkillSnapshot;
	headError?: Error;
	pinnedError?: Error;
}): FreshnessFetch {
	return {
		async resolveHead(_url: string): Promise<string> {
			if (options.headError) throw options.headError;
			return options.head ?? REV1;
		},
		async fetchSnapshot(
			_source: UpstreamSource,
			_revision: string,
		): Promise<SkillSnapshot> {
			if (options.pinnedError) throw options.pinnedError;
			if (!options.pinned) throw new Error("no pinned snapshot in fake");
			return options.pinned;
		},
	};
}

function localDir(content: string): string {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-freshness-"));
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "SKILL.md"), content);
	return root;
}

test("freshness reports up to date when local matches the pin and upstream HEAD has not moved", async () => {
	const root = localDir("version one\n");
	try {
		const service = new FreshnessService(
			fakeFetch({ head: REV1, pinned: snapshot(REV1, "version one\n") }),
		);
		const report = await service.check({
			skill: "example-skill",
			source: SOURCE,
			localSkillDir: root,
		});
		assert.equal(report.state, "up-to-date");
		assert.equal(report.error, null);
		assert.equal(report.upstreamHead, REV1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("freshness reports update available when upstream advanced past the pinned revision", async () => {
	const root = localDir("version one\n");
	try {
		const service = new FreshnessService(
			fakeFetch({ head: REV2, pinned: snapshot(REV1, "version one\n") }),
		);
		const report = await service.check({
			skill: "example-skill",
			source: SOURCE,
			localSkillDir: root,
		});
		assert.equal(report.state, "update-available");
		assert.equal(report.sourceRepo, "acme/skills");
		assert.equal(report.upstreamHead, REV2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("freshness reports drifted when the local copy diverges from the pinned revision", async () => {
	const root = localDir("edited locally\n");
	try {
		const service = new FreshnessService(
			fakeFetch({ head: REV1, pinned: snapshot(REV1, "version one\n") }),
		);
		const report = await service.check({
			skill: "example-skill",
			source: SOURCE,
			localSkillDir: root,
		});
		assert.equal(report.state, "drifted");
		assert.notEqual(report.state, "up-to-date");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("freshness reports unreachable honestly with the fetch error surfaced (mocked failure)", async () => {
	const root = localDir("version one\n");
	try {
		const networkError = new Error("network failure: connection refused");
		const service = new FreshnessService(
			fakeFetch({ headError: networkError }),
		);
		const report = await service.check({
			skill: "example-skill",
			source: SOURCE,
			localSkillDir: root,
		});
		assert.equal(report.state, "unreachable");
		assert.ok(report.error?.includes("network failure"), report.error ?? "");
		assert.notEqual(report.state, "up-to-date");
		assert.notEqual(report.state, "update-available");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a pinned-revision fetch failure is also reported as unreachable, never silent", async () => {
	const root = localDir("version one\n");
	try {
		const service = new FreshnessService(
			fakeFetch({ head: REV1, pinnedError: new Error("clone failed") }),
		);
		const report = await service.check({
			skill: "example-skill",
			source: SOURCE,
			localSkillDir: root,
		});
		assert.equal(report.state, "unreachable");
		assert.ok(report.error?.includes("clone failed"), report.error ?? "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("sourceRepoDisplayName names the repo for github URLs and falls back to path segments", () => {
	assert.equal(
		sourceRepoDisplayName("https://github.com/acme/skills.git"),
		"acme/skills",
	);
	assert.equal(
		sourceRepoDisplayName("https://github.com/acme/skills"),
		"acme/skills",
	);
	// A local mock remote shaped like the source repo still names it.
	assert.equal(
		sourceRepoDisplayName("C:/tmp/x/acme/skills.git"),
		"acme/skills",
	);
	assert.equal(sourceRepoDisplayName(""), null);
});
