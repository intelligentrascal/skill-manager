import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ImportError,
	OriginImportService,
	type GithubFetcher,
} from "../src/import.ts";

const SKILL = `---\nname: demo\ndescription: A demo skill.\n---\n\n## Workflow\nDo the thing.\n`;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(root: string, remote: string): void {
	mkdirSync(root, { recursive: true });
	git(root, ["init", "--initial-branch=main"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "Test"]);
	git(root, ["remote", "add", "origin", remote]);
}

function initBare(remote: string): void {
	mkdirSync(remote, { recursive: true });
	git(remote, ["init", "--bare", "--initial-branch=main"]);
}

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "skill-manager-origin-test-"));
}

const fakeFetcher: GithubFetcher = {
	async pinRevision(cloneUrl: string): Promise<string> {
		return "deadbeefcafe";
	},
	async fetchSkill(
		_cloneUrl: string,
		revision: string,
		_subpath: string,
	): Promise<string> {
		return `pinned at ${revision}\n`;
	},
};

test("preview for a GitHub origin pins the revision and records a verified identity", async () => {
	const service = new OriginImportService(fakeFetcher);
	const root = tmpRoot();
	try {
		const preview = await service.preview(root, {
			skillName: "demo",
			origin: {
				type: "github",
				reason: "imported from upstream",
				url: "https://github.com/acme/skills.git",
				subpath: "skills/demo",
			},
			expectedContentSha: "",
		});
		assert.equal(preview.contentSha.length, 64);
		assert.equal(preview.provenance, "upstream");
		assert.equal(preview.identity?.upstreamUrl, "https://github.com/acme/skills.git");
		assert.equal(preview.identity?.subpath, "skills/demo");
		assert.equal(preview.identity?.pinnedRevision, "deadbeefcafe");
		assert.equal(preview.pinnedRevision, "deadbeefcafe");
		assert.equal(preview.origin.verifiedAt !== undefined, true);
		assert.equal(preview.alreadyManaged, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("preview for a local origin reads and hashes the discovered copy", async () => {
	const service = new OriginImportService(fakeFetcher);
	const root = tmpRoot();
	const source = join(root, "discovered", "SKILL.md");
	mkdirSync(join(root, "discovered"), { recursive: true });
	writeFileSync(source, SKILL);
	try {
		const preview = await service.preview(root, {
			skillName: "demo",
			origin: { type: "local", reason: "I wrote this" },
			expectedContentSha: "",
			sourcePath: source,
		});
		assert.equal(preview.provenance, "mine");
		assert.equal(preview.content, SKILL);
		assert.equal(preview.contentSha.length, 64);
		assert.equal(preview.identity, undefined);
		assert.equal(preview.origin.verifiedAt, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("assign imports a local copy, records the origin, commits, and pushes", async () => {
	const root = tmpRoot();
	const remote = join(root, "remote.git");
	const repo = join(root, "repo");
	const source = join(root, "discovered", "SKILL.md");
	mkdirSync(join(root, "discovered"), { recursive: true });
	writeFileSync(source, SKILL);
	initBare(remote);
	initRepo(repo, remote);
	git(repo, ["commit", "--allow-empty", "-m", "base"]);
	git(repo, ["push", "-u", "origin", "main"]);

	const service = new OriginImportService(fakeFetcher);
	try {
		const preview = await service.preview(repo, {
			skillName: "demo",
			category: "misc",
			origin: { type: "local", reason: "I wrote this", ownershipNote: "scratch" },
			expectedContentSha: "",
			sourcePath: source,
		});
		const result = await service.assign(repo, {
			skillName: "demo",
			category: "misc",
			origin: { type: "local", reason: "I wrote this", ownershipNote: "scratch" },
			expectedContentSha: preview.contentSha,
			sourcePath: source,
		});

		assert.equal(result.committed, true);
		assert.equal(result.pushed, true);
		assert.ok(result.commitSha);
		assert.equal(result.origin.type, "local");

		const target = join(repo, "skills", "misc", "demo", "SKILL.md");
		assert.equal(readFileSync(target, "utf8"), SKILL);
		assert.ok(readFileSync(join(repo, "skillmgr.yaml"), "utf8").includes("type: local"));

		// The commit reached the remote.
		const remoteHead = git(remote, ["rev-parse", "main"]);
		assert.equal(remoteHead, result.commitSha);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("assign refuses when the source changed after preview", async () => {
	const root = tmpRoot();
	const repo = join(root, "repo");
	const remote = join(root, "remote.git");
	const source = join(root, "discovered", "SKILL.md");
	mkdirSync(join(root, "discovered"), { recursive: true });
	writeFileSync(source, SKILL);
	initBare(remote);
	initRepo(repo, remote);
	git(repo, ["commit", "--allow-empty", "-m", "base"]);

	const service = new OriginImportService(fakeFetcher);
	try {
		const preview = await service.preview(repo, {
			skillName: "demo",
			origin: { type: "local", reason: "r" },
			expectedContentSha: "",
			sourcePath: source,
		});
		writeFileSync(source, "changed after preview\n");
		await assert.rejects(
			() =>
				service.assign(repo, {
					skillName: "demo",
					origin: { type: "local", reason: "r" },
					expectedContentSha: preview.contentSha,
					sourcePath: source,
				}),
			/source changed/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("assign refuses to overwrite a conflicting canonical copy", async () => {
	const root = tmpRoot();
	const repo = join(root, "repo");
	const remote = join(root, "remote.git");
	initBare(remote);
	initRepo(repo, remote);
	// An existing canonical copy with different content.
	const existing = join(repo, "skills", "misc", "demo", "SKILL.md");
	mkdirSync(join(existing, ".."), { recursive: true });
	writeFileSync(existing, "existing different content\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "existing"]);

	const service = new OriginImportService(fakeFetcher);
	try {
		const other = join(root, "other", "SKILL.md");
		mkdirSync(join(root, "other"), { recursive: true });
		writeFileSync(other, "other content\n");
		const preview = await service.preview(repo, {
			skillName: "demo",
			origin: { type: "local", reason: "r" },
			expectedContentSha: "",
			sourcePath: other,
		});
		assert.equal(preview.alreadyManaged, true);
		await assert.rejects(
			() =>
				service.assign(repo, {
					skillName: "demo",
					origin: { type: "local", reason: "r" },
					expectedContentSha: preview.contentSha,
					sourcePath: other,
				}),
			/A canonical copy already exists/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a rejected push leaves the commit inspectable and retryable", async () => {
	const root = tmpRoot();
	const remote = join(root, "remote.git");
	const repo = join(root, "repo");
	const diverger = join(root, "diverger");
	initBare(remote);
	initRepo(repo, remote);
	git(repo, ["commit", "--allow-empty", "-m", "base"]);
	git(repo, ["push", "-u", "origin", "main"]);

	// A second clone advances the remote, so the next push is non-fast-forward.
	git(root, ["clone", remote, diverger]);
	git(diverger, ["config", "user.email", "test@example.com"]);
	git(diverger, ["config", "user.name", "Test"]);
	writeFileSync(join(diverger, "other.txt"), "diverging\n");
	git(diverger, ["add", "."]);
	git(diverger, ["commit", "-m", "diverging"]);
	git(diverger, ["push", "origin", "main"]);

	const service = new OriginImportService(fakeFetcher);
	try {
		const source = join(root, "discovered", "SKILL.md");
		mkdirSync(join(root, "discovered"), { recursive: true });
		writeFileSync(source, SKILL);
		const preview = await service.preview(repo, {
			skillName: "demo",
			origin: { type: "local", reason: "r" },
			expectedContentSha: "",
			sourcePath: source,
		});
		const result = await service.assign(repo, {
			skillName: "demo",
			origin: { type: "local", reason: "r" },
			expectedContentSha: preview.contentSha,
			sourcePath: source,
		});

		assert.equal(result.pushed, false);
		assert.equal(result.retryable, true);
		assert.ok(result.pushError);
		assert.ok(result.commitSha);
		// The verified local commit remains on the branch for inspection/retry.
		assert.equal(git(repo, ["rev-parse", "HEAD"]), result.commitSha);
		assert.ok(git(repo, ["log", "--oneline", "-1"]).includes("assign origin"));
		assert.ok(existsSync(join(repo, "skills", "misc", "demo", "SKILL.md")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("private origins without attribution are rejected before any write", async () => {
	const root = tmpRoot();
	const repo = join(root, "repo");
	const remote = join(root, "remote.git");
	initBare(remote);
	initRepo(repo, remote);
	git(repo, ["commit", "--allow-empty", "-m", "base"]);

	const service = new OriginImportService(fakeFetcher);
	try {
		await assert.rejects(
			() =>
				service.assign(repo, {
					skillName: "demo",
					origin: { type: "private", reason: "from a community thread" },
					expectedContentSha: "x",
					sourcePath: join(root, "x", "SKILL.md"),
				}),
			/attribution/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
