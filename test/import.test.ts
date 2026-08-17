import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
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
import { parseManifest } from "../src/manifest.ts";

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

/** Register a temp dir as the only approved scan location for a test. */
function testScanLocations(root: string) {
	return [{ name: "test-scan", root }];
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
	const root = tmpRoot();
	const service = new OriginImportService(fakeFetcher, testScanLocations(root));
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

	const service = new OriginImportService(fakeFetcher, testScanLocations(root));
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

	const service = new OriginImportService(fakeFetcher, testScanLocations(root));
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

	const service = new OriginImportService(fakeFetcher, testScanLocations(root));
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

	const service = new OriginImportService(fakeFetcher, testScanLocations(root));
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

test("preview rejects a sensitive non-skill file as sourcePath", async () => {
	const root = tmpRoot();
	try {
		const approved = join(root, "approved");
		mkdirSync(approved, { recursive: true });
		const secrets = join(root, "secrets");
		mkdirSync(secrets, { recursive: true });
		writeFileSync(
			join(secrets, "id_rsa"),
			"-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-material\n",
		);
		const service = new OriginImportService(
			fakeFetcher,
			[{ name: "approved", root: approved }],
		);
		await assert.rejects(
			() =>
				service.preview(join(root, "repo"), {
					skillName: "demo",
					origin: { type: "local", reason: "r" },
					expectedContentSha: "",
					sourcePath: join(secrets, "id_rsa"),
				}),
			/SKILL\.md/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("preview rejects a SKILL.md outside any approved scan location", async () => {
	const root = tmpRoot();
	try {
		const approved = join(root, "approved");
		mkdirSync(approved, { recursive: true });
		const elsewhere = join(root, "elsewhere");
		mkdirSync(join(elsewhere, "demo"), { recursive: true });
		writeFileSync(join(elsewhere, "demo", "SKILL.md"), SKILL);
		const service = new OriginImportService(
			fakeFetcher,
			[{ name: "approved", root: approved }],
		);
		await assert.rejects(
			() =>
				service.preview(join(root, "repo"), {
					skillName: "demo",
					origin: { type: "local", reason: "r" },
					expectedContentSha: "",
					sourcePath: join(elsewhere, "demo", "SKILL.md"),
				}),
			/approved scan location/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("preview rejects a SKILL.md in a skipped directory inside an approved location", async () => {
	const root = tmpRoot();
	try {
		const approved = join(root, "approved");
		mkdirSync(join(approved, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(approved, "node_modules", "pkg", "SKILL.md"), SKILL);
		const service = new OriginImportService(
			fakeFetcher,
			[{ name: "approved", root: approved }],
		);
		await assert.rejects(
			() =>
				service.preview(join(root, "repo"), {
					skillName: "demo",
					origin: { type: "local", reason: "r" },
					expectedContentSha: "",
					sourcePath: join(approved, "node_modules", "pkg", "SKILL.md"),
				}),
			/discovered/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("preview rejects a symlinked sourcePath that escapes an approved location", async (t) => {
	const root = tmpRoot();
	try {
		const approved = join(root, "approved");
		mkdirSync(join(approved, "demo"), { recursive: true });
		const secrets = join(root, "secrets");
		mkdirSync(secrets, { recursive: true });
		writeFileSync(join(secrets, "id_rsa"), "PRIVATE KEY MATERIAL\n");
		const link = join(approved, "demo", "SKILL.md");
		try {
			symlinkSync(join(secrets, "id_rsa"), link);
		} catch {
			t.skip("symlinks not available on this platform");
			return;
		}
		const service = new OriginImportService(
			fakeFetcher,
			[{ name: "approved", root: approved }],
		);
		await assert.rejects(
			() =>
				service.preview(join(root, "repo"), {
					skillName: "demo",
					origin: { type: "local", reason: "r" },
					expectedContentSha: "",
					sourcePath: link,
				}),
			/approved scan location/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("assign pushes the commit to main even when HEAD is on a feature branch", async () => {
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
	git(repo, ["checkout", "-b", "feature"]);

	const service = new OriginImportService(fakeFetcher, testScanLocations(root));
	try {
		const preview = await service.preview(repo, {
			skillName: "demo",
			category: "misc",
			origin: { type: "local", reason: "r" },
			expectedContentSha: "",
			sourcePath: source,
		});
		const result = await service.assign(repo, {
			skillName: "demo",
			category: "misc",
			origin: { type: "local", reason: "r" },
			expectedContentSha: preview.contentSha,
			sourcePath: source,
		});

		assert.equal(result.pushed, true);
		assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "feature");
		// The verified commit landed on origin/main, not a new origin/feature branch.
		assert.equal(git(remote, ["rev-parse", "main"]), result.commitSha);
		assert.throws(() => git(remote, ["rev-parse", "feature"]));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const namedFetcher = (skillBody: string): GithubFetcher => ({
	async pinRevision(_cloneUrl: string): Promise<string> {
		return "pinned-rev-1";
	},
	async fetchSkill(
		_cloneUrl: string,
		_revision: string,
		_subpath: string,
	): Promise<string> {
		return skillBody;
	},
});

const LAVISH_SKILL = `---\nname: lavish\ndescription: rich HTML artifacts\n---\n\n## Workflow\nRender it.\n`;

function scaffoldRepo(root: string, remote: string, repo: string): void {
	initBare(remote);
	initRepo(repo, remote);
	git(repo, ["commit", "--allow-empty", "-m", "base"]);
	git(repo, ["push", "-u", "origin", "main"]);
}

function writeExistingManifest(repo: string, text: string): void {
	writeFileSync(join(repo, "skillmgr.yaml"), text);
	git(repo, ["add", "--", "skillmgr.yaml"]);
	git(repo, ["commit", "-m", "existing manifest"]);
}

test("a reasonless verified github assignment records the frontmatter name as canonicalName", async () => {
	const root = tmpRoot();
	const repo = join(root, "repo");
	const remote = join(root, "remote.git");
	scaffoldRepo(root, remote, repo);
	const service = new OriginImportService(namedFetcher(LAVISH_SKILL));
	try {
		const origin = {
			type: "github",
			url: "https://github.com/kunchenguid/lavish-axi.git",
			subpath: "skills/lavish",
		};
		const preview = await service.preview(repo, {
			skillName: "Curet1fa",
			category: "misc",
			origin,
			expectedContentSha: "",
		});
		assert.equal(preview.content, LAVISH_SKILL);
		assert.equal(preview.canonicalName, "lavish");

		const result = await service.assign(repo, {
			skillName: "Curet1fa",
			category: "misc",
			origin,
			expectedContentSha: preview.contentSha,
		});
		assert.equal(result.committed, true);
		assert.equal(result.pushed, true);

		const manifestText = readFileSync(join(repo, "skillmgr.yaml"), "utf8");
		const parsed = parseManifest(manifestText);
		const record = parsed.skills["Curet1fa"];
		// The record key is the pre-existing local name - never renamed.
		assert.ok(record);
		assert.equal(record.canonicalName, "lavish");
		assert.equal(record.provenance, "upstream");
		assert.equal(record.origin!.current.type, "github");
		assert.equal(record.origin!.current.reason, undefined);
		assert.equal(record.identity!.upstreamUrl, "https://github.com/kunchenguid/lavish-axi.git");
		// The manifest round-trips with the verified name intact.
		assert.equal(
			parseManifest(
				readFileSync(join(repo, "skillmgr.yaml"), "utf8"),
			).skills["Curet1fa"].canonicalName,
			"lavish",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a frontmatter-less github import derives the verified name from the repo", async () => {
	const root = tmpRoot();
	const repo = join(root, "repo");
	const remote = join(root, "remote.git");
	scaffoldRepo(root, remote, repo);
	const service = new OriginImportService(
		namedFetcher("---\ndescription: no name declared\n---\n\nBody.\n"),
	);
	try {
		const preview = await service.preview(repo, {
			skillName: "Curet1fa",
			origin: {
				type: "github",
				url: "https://github.com/kunchenguid/lavish-axi.git",
				subpath: "skills/lavish",
			},
			expectedContentSha: "",
		});
		assert.equal(preview.canonicalName, "lavish-axi");
		const result = await service.assign(repo, {
			skillName: "Curet1fa",
			origin: {
				type: "github",
				url: "https://github.com/kunchenguid/lavish-axi.git",
				subpath: "skills/lavish",
			},
			expectedContentSha: preview.contentSha,
		});
		assert.equal(result.committed, true);
		const record = parseManifest(
			readFileSync(join(repo, "skillmgr.yaml"), "utf8"),
		).skills["Curet1fa"];
		assert.equal(record.canonicalName, "lavish-axi");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("github reassignment keeps the key stable and preserves prior origin history", async () => {
	const root = tmpRoot();
	const repo = join(root, "repo");
	const remote = join(root, "remote.git");
	const source = join(root, "discovered", "SKILL.md");
	mkdirSync(join(root, "discovered"), { recursive: true });
	writeFileSync(source, LAVISH_SKILL);
	scaffoldRepo(root, remote, repo);
	// A prior local origin exists in the manifest under the same key.
	writeExistingManifest(
		repo,
		`version: 1\nskills:\n  Curet1fa:\n    provenance: mine\n    origin:\n      current:\n        type: local\n        at: 2026-08-16T00:00:00.000Z\n        reason: written locally\n        ownershipNote: scratch\n`,
	);
	const service = new OriginImportService(
		namedFetcher(LAVISH_SKILL),
		testScanLocations(root),
	);
	try {
		const preview = await service.preview(repo, {
			skillName: "Curet1fa",
			category: "misc",
			origin: {
				type: "github",
				url: "https://github.com/kunchenguid/lavish-axi.git",
				subpath: "skills/lavish",
			},
			expectedContentSha: "",
			sourcePath: source,
		});
		const result = await service.assign(repo, {
			skillName: "Curet1fa",
			category: "misc",
			origin: {
				type: "github",
				url: "https://github.com/kunchenguid/lavish-axi.git",
				subpath: "skills/lavish",
			},
			expectedContentSha: preview.contentSha,
			sourcePath: source,
		});
		assert.equal(result.committed, true);

		const parsed = parseManifest(
			readFileSync(join(repo, "skillmgr.yaml"), "utf8"),
		);
		const record = parsed.skills["Curet1fa"];
		assert.equal(record.canonicalName, "lavish");
		assert.equal(record.origin!.current.type, "github");
		// Append-only: the prior local origin is preserved in history.
		assert.equal(record.origin!.history.length, 1);
		assert.equal(record.origin!.history[0].type, "local");
		assert.equal(record.origin!.history[0].reason, "written locally");
		assert.equal(record.origin!.history[0].ownershipNote, "scratch");
		// The manifest key never changes - the prior name is preserved.
		assert.equal(Object.keys(parsed.skills).includes("Curet1fa"), true);
		assert.equal(parsed.skills["Curet1fa"].canonicalName, "lavish");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("assigning to a CRLF manifest keeps the diff minimal", async () => {
	const root = tmpRoot();
	const repo = join(root, "repo");
	const remote = join(root, "remote.git");
	scaffoldRepo(root, remote, repo);
	const crlfManifest =
		"# header\r\nversion: 1\r\nskills:\r\n  keeper:\r\n    provenance: mine\r\n";
	writeExistingManifest(repo, crlfManifest);
	const service = new OriginImportService(namedFetcher(LAVISH_SKILL));
	try {
		const preview = await service.preview(repo, {
			skillName: "Curet1fa",
			category: "misc",
			origin: {
				type: "github",
				url: "https://github.com/kunchenguid/lavish-axi.git",
				subpath: "skills/lavish",
			},
			expectedContentSha: "",
		});
		await service.assign(repo, {
			skillName: "Curet1fa",
			category: "misc",
			origin: {
				type: "github",
				url: "https://github.com/kunchenguid/lavish-axi.git",
				subpath: "skills/lavish",
			},
			expectedContentSha: preview.contentSha,
		});
		const written = readFileSync(join(repo, "skillmgr.yaml"), "utf8");
		// The keeper entry keeps CRLF untouched; only the new entry is added.
		assert.ok(written.startsWith("# header\r\nversion: 1\r\nskills:\r\n  keeper:\r\n    provenance: mine\r\n"));
		const withoutCrlf = written.split("\r\n").join("");
		assert.ok(!withoutCrlf.includes("\n"), "manifest must stay CRLF after assign");
		assert.equal(parseManifest(written).skills["keeper"].provenance, "mine");
		assert.equal(parseManifest(written).skills["Curet1fa"].canonicalName, "lavish");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
