import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { GitUpstreamUpdateService, assessSecurityGate, computeDiff, snapshotDirectory } from "../src/updates.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function writeSkill(root: string, body: string, script?: string): void {
	mkdirSync(join(root, "skills", "demo"), { recursive: true });
	writeFileSync(join(root, "skills", "demo", "SKILL.md"), body);
	if (script) {
		const path = join(root, "skills", "demo", "run.sh");
		writeFileSync(path, script);
		chmodSync(path, 0o755);
	}
}

test("computeDiff marks changed executable behavior for acknowledgement", () => {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-update-diff-"));
	try {
		const before = { revision: "one", files: [] };
		const after = {
			revision: "two",
			files: [{ path: "run.sh", sha: "two", bytes: 20, executable: true, content: "#!/bin/sh\ncurl https://example.test\n" }],
		};
		const changes = computeDiff(before, after);
		const script = changes.find((change) => change.path === "run.sh");
		assert.equal(script?.kind, "added");
		assert.ok(script?.behaviorSignals.includes("executable-file"));
		assert.equal(assessSecurityGate(changes).state, "acknowledgement-required");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fetch, staged apply, verification, and rollback use a temporary shallow clone", async () => {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-update-flow-"));
	const upstream = join(root, "upstream");
	const mirror = join(root, "mirror");
	mkdirSync(upstream);
	try {
		git(upstream, ["init", "--initial-branch=main"]);
		git(upstream, ["config", "user.email", "test@example.com"]);
		git(upstream, ["config", "user.name", "Test"]);
		writeSkill(upstream, "version one\n");
		git(upstream, ["add", "."]);
		git(upstream, ["commit", "-m", "one"]);
		const first = git(upstream, ["rev-parse", "HEAD"]);
		mkdirSync(mirror, { recursive: true });
		writeFileSync(join(mirror, "SKILL.md"), "version one\n");
		writeSkill(upstream, "version two\n");
		git(upstream, ["add", "."]);
		git(upstream, ["commit", "-m", "two"]);
		const second = git(upstream, ["rev-parse", "HEAD"]);

		const service = new GitUpstreamUpdateService();
		const request = {
			skillId: "demo",
			source: { url: upstream, subpath: "skills/demo", pinnedRevision: first },
			targetRevision: second,
			repoMirrorPath: mirror,
		};
		const preview = await service.preview(request);
		assert.equal(preview.security.state, "clear");
		assert.ok(preview.changes.some((change) => change.kind === "modified"));
		const staged = await service.stage(preview);
		const applied = await service.apply(staged);
		assert.equal(readFileSync(join(mirror, "SKILL.md"), "utf-8").trim(), "version two");
		const rolledBack = await service.rollback(applied);
		assert.equal(rolledBack.restoredRevision, first);
		assert.equal(readFileSync(join(mirror, "SKILL.md"), "utf-8").trim(), "version one");
		service.dispose();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
