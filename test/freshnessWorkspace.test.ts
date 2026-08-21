import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseManifest } from "../src/manifest.ts";
import { reservePort, stopChild, waitForServer } from "./workspaceServer.ts";

// ---------------------------------------------------------------------------
// Shared harness: a mocked upstream GitHub remote (a bare git remote) plus a
// seeded agent-skills repo, served by a spawned src/server.ts with SM_* env
// overrides pointing into a temp root.
// ---------------------------------------------------------------------------

const REV = "a".repeat(40);

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function fwd(path: string): string {
	return path.replaceAll("\\", "/");
}

interface Workspace {
	root: string;
	/** Mock upstream (bare remote), e.g. <root>/acme/skills.git. */
	bare: string;
	/** Forward-slash upstream URL recorded in the manifest. */
	upstreamUrl: string;
	repoRoot: string;
	skillDir: string;
	manifestPath: string;
	remoteBare: string;
	base: string;
	child: ChildProcess;
	output: () => string;
}

function initGitRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test"]);
}

/**
 * Seed the mock upstream with a first revision and return its sha (upstream
 * HEAD stays at rev1 until advanceUpstream runs). allowReachableSHA1InWant
 * lets the shallow fetch of the older (unadvertised) pinned revision succeed -
 * the same server primitive the spec reuses (GitUpstreamUpdateService.fetchSnapshot).
 */
function seedUpstream(root: string, content1: string): string {
	const work = join(root, "upstream-work");
	initGitRepo(work);
	const bare = join(root, "acme", "skills.git");
	mkdirSync(dirname(bare), { recursive: true });
	// --initial-branch keeps the bare's HEAD symref pointing at the pushed
	// branch (a default bare would advertise refs/heads/master and leave HEAD
	// dangling, so ls-remote HEAD would resolve to nothing).
	execFileSync("git", ["init", "--bare", "--initial-branch=main", bare]);
	git(work, ["remote", "add", "origin", bare]);
	const skillDir = join(work, "skills", "example-skill");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), content1);
	git(work, ["add", "."]);
	git(work, ["commit", "-m", "one"]);
	const rev1 = git(work, ["rev-parse", "HEAD"]);
	git(work, ["push", "origin", "main"]);
	git(bare, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
	return rev1;
}

/** Advance the mock upstream to a second revision and return its sha. */
function advanceUpstream(root: string, content2: string): string {
	const work = join(root, "upstream-work");
	writeFileSync(join(work, "skills", "example-skill", "SKILL.md"), content2);
	git(work, ["add", "."]);
	git(work, ["commit", "-m", "two"]);
	git(work, ["push", "origin", "main"]);
	return git(work, ["rev-parse", "HEAD"]);
}

function manifestText(identity: {
	upstreamUrl: string;
	subpath: string;
	pinnedRevision: string;
}): string {
	return (
		"version: 1\n" +
		"skills:\n" +
		"  example-skill:\n" +
		"    provenance: upstream\n" +
		"    identity:\n" +
		`      upstreamUrl: ${identity.upstreamUrl}\n` +
		`      subpath: ${identity.subpath}\n` +
		`      pinnedRevision: ${identity.pinnedRevision}\n` +
		"    origin:\n" +
		"      current:\n" +
		"        type: github\n" +
		"        at: 2026-08-21T00:00:00.000Z\n" +
		"  local-skill:\n" +
		"    provenance: mine\n" +
		"    origin:\n" +
		"      current:\n" +
		"        type: local\n" +
		"        at: 2026-08-21T00:00:00.000Z\n" +
		"        reason: local only\n"
	);
}

async function startWorkspace(options: {
	localContent: string;
	identity: {
		upstreamUrl: string;
		subpath: string;
		pinnedRevision: string;
	};
}): Promise<Workspace> {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-freshness-ws-"));
	const repoRoot = join(root, "agent-skills");
	const skillDir = join(repoRoot, "skills", "misc", "example-skill");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), options.localContent);
	mkdirSync(join(repoRoot, "skills", "misc", "local-skill"), { recursive: true });
	writeFileSync(
		join(repoRoot, "skills", "misc", "local-skill", "SKILL.md"),
		"local only\n",
	);
	const manifestPath = join(repoRoot, "skillmgr.yaml");
	writeFileSync(manifestPath, manifestText(options.identity));
	initGitRepo(repoRoot);
	const remoteBare = join(root, "agent-skills-remote.git");
	execFileSync("git", ["init", "--bare", "--initial-branch=main", remoteBare]);
	git(repoRoot, ["remote", "add", "origin", remoteBare]);
	git(repoRoot, ["add", "."]);
	git(repoRoot, ["commit", "-m", "seed"]);
	git(repoRoot, ["push", "origin", "main"]);

	const empty = join(root, "empty");
	mkdirSync(empty, { recursive: true });
	// Deterministic git: the server's git reads its global config from HOME.
	// With no user config it falls back to the system default (core.autocrlf=
	// true on git-for-Windows), which converts the fetched working tree to CRLF
	// and makes byte comparison against the LF fixtures lie. Pin autocrlf off.
	writeFileSync(
		join(root, ".gitconfig"),
		"[core]\nautocrlf = false\n",
	);
	const port = await reservePort();
	let output = "";
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "src/server.ts"],
		{
			cwd: process.cwd(),
			detached: process.platform !== "win32",
			env: {
				...process.env,
				HOME: root,
				USERPROFILE: root,
				SM_PORT: String(port),
				SM_PI_SKILLS: join(root, ".pi", "agent", "skills"),
				SM_OPENCODE_SKILLS: empty,
				SM_CLAUDE_SKILLS: empty,
				SM_SHARED_SKILLS: empty,
				SM_REPO_SKILLS: join(repoRoot, "skills"),
				SM_EVIDENCE_REGISTRY_ROOT: repoRoot,
				SM_CACHE_DIR: join(root, "cache"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	child.stdout?.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr?.on("data", (chunk) => {
		output += String(chunk);
	});
	const base = `http://127.0.0.1:${port}`;
	await waitForServer(`${base}/`, child, () => output);
	return {
		root,
		bare: "",
		upstreamUrl: "",
		repoRoot,
		skillDir,
		manifestPath,
		remoteBare,
		base,
		child,
		output: () => output,
	};
}

async function json(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
	const response = await fetch(url, init);
	const body = await response.json().catch(() => ({}));
	return { ok: response.ok, status: response.status, body };
}

function dirname(path: string): string {
	return path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
}

// ---------------------------------------------------------------------------
// Freshness scenarios (spec/freshness-check.feature)
// ---------------------------------------------------------------------------

test("freshness scenarios: up to date, update available, drifted, unreachable, and no-origin", async () => {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-freshness-scen-"));
	try {
		// Upstream HEAD stays at REV1 until the second scenario advances it.
		const rev1 = seedUpstream(root, "version one\n");
		const bare = join(root, "acme", "skills.git");
		const ws = await startWorkspace({
			localContent: "version one\n",
			identity: {
				upstreamUrl: fwd(bare),
				subpath: "skills/example-skill",
				pinnedRevision: rev1,
			},
		});
		ws.bare = bare;
		ws.upstreamUrl = fwd(bare);
		try {
			// Scenario: up to date (pin REV1, local REV1, upstream HEAD REV1).
			const s1 = await json(`${ws.base}/api/freshness?name=example-skill`);
			assert.equal(s1.status, 200);
			assert.equal(s1.body.state, "up-to-date");

			// Upstream HEAD advances to REV2 -> update available.
			const rev2 = advanceUpstream(root, "version two\n");
			const s2 = await json(`${ws.base}/api/freshness?name=example-skill`);
			assert.equal(s2.status, 200);
			assert.equal(s2.body.state, "update-available");
			// the report names the source repo, never a bare label
			assert.equal(s2.body.sourceRepo, "acme/skills");
			assert.equal(s2.body.upstreamHead, rev2);

			// Local copy edited -> drifted (upstream HEAD still REV2; drift wins).
			writeFileSync(join(ws.skillDir, "SKILL.md"), "edited locally\n");
			const s3 = await json(`${ws.base}/api/freshness?name=example-skill`);
			assert.equal(s3.status, 200);
			assert.equal(s3.body.state, "drifted");
			assert.notEqual(s3.body.state, "up-to-date");

			// Upstream unreachable -> honest unreachable with the error surfaced.
			writeFileSync(
				ws.manifestPath,
				manifestText({
					upstreamUrl: fwd(join(root, "missing", "skills.git")),
					subpath: "skills/example-skill",
					pinnedRevision: rev1,
				}),
			);
			const s4 = await json(`${ws.base}/api/freshness?name=example-skill`);
			assert.equal(s4.status, 200);
			assert.equal(s4.body.state, "unreachable");
			assert.equal(typeof s4.body.error, "string");
			assert.ok(String(s4.body.error).length > 0, "the fetch error is surfaced");
			assert.notEqual(s4.body.state, "up-to-date");
			assert.notEqual(s4.body.state, "update-available");

			// No verified public GitHub origin -> 404, no fetch attempted.
			const s5 = await json(`${ws.base}/api/freshness?name=local-skill`);
			assert.equal(s5.status, 404);
			assert.equal(s5.body.available, false);
		} finally {
			await stopChild(ws.child);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Update path (spec: review -> verified apply vs the pinned revision)
// ---------------------------------------------------------------------------

test("update path runs the review then the verified apply against the pinned revision", async () => {
	const content1 = "---\nname: example-skill\ndescription: A sample skill.\n---\n\nVersion one body.\n";
	const content2 = "---\nname: example-skill\ndescription: A sample skill.\n---\n\nVersion two body.\n";
	const root = mkdtempSync(join(tmpdir(), "skill-manager-updatepath-"));
	try {
		seedUpstream(root, content1); // upstream seeded at REV1, then advanced
		const rev2 = advanceUpstream(root, content2);
		const bare = join(root, "acme", "skills.git");
		const ws = await startWorkspace({
			localContent: content1, // repo copy still matches REV1
			identity: {
				upstreamUrl: fwd(bare),
				subpath: "skills/example-skill",
				pinnedRevision: rev2, // pin already advanced to REV2
			},
		});
		try {
			const seedHead = git(ws.repoRoot, ["rev-parse", "HEAD"]);

			// The pin is REV2 while local matches REV1 -> drifted.
			const fresh = await json(`${ws.base}/api/freshness?name=example-skill`);
			assert.equal(fresh.body.state, "drifted");

			// Opening the update path generates an Adaptation Review (#6) with
			// the current repo copy as baseline and the pinned REV2 as incoming.
			const review = await json(`${ws.base}/api/adaptation-review`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "example-skill" }),
			});
			assert.equal(review.status, 200);
			assert.equal(review.body.skill, "example-skill");
			assert.equal(review.body.sourceRevision, rev2);
			// The #6 review labels the canonical baseline with the pinned
			// revision (the provenance claim), not the stale local content.
			assert.equal(review.body.canonicalRevision, rev2);
			assert.equal(Array.isArray(review.body.agents), true);
			assert.equal((review.body.agents as unknown[]).length, 4);
			assert.equal(
				(review.body.changeSummary as { bodyChanged: boolean }).bodyChanged,
				true,
			);

			// Preview only: nothing was applied, committed, or pushed.
			assert.equal(git(ws.repoRoot, ["rev-parse", "HEAD"]), seedHead);
			assert.equal(
				readFileSync(join(ws.skillDir, "SKILL.md"), "utf-8"),
				content1,
			);

			// Confirmed apply (#7): stage -> deploy -> verify -> commit -> push.
			const apply = await json(`${ws.base}/api/adaptation-review/apply`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "example-skill", review: review.body }),
			});
			assert.equal(apply.status, 200);
			assert.equal(apply.body.committed, true);
			assert.equal(apply.body.pushed, true);

			// The local canonical copy now matches REV2 and the manifest records
			// the applied revision in provenance.
			assert.equal(
				readFileSync(join(ws.skillDir, "SKILL.md"), "utf-8"),
				content2,
			);
			const manifest = parseManifest(
				readFileSync(ws.manifestPath, "utf-8"),
			);
			assert.equal(
				manifest.skills["example-skill"].identity?.pinnedRevision,
				rev2,
			);
			assert.equal(
				git(ws.remoteBare, ["rev-parse", "main"]),
				String(apply.body.commitSha),
			);
		} finally {
			await stopChild(ws.child);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Explicit re-pin (spec: updating to a newer revision requires a re-pin)
// ---------------------------------------------------------------------------

test("updating to a newer revision requires an explicit re-pin, then review/apply run against it", async () => {
	const content1 = "---\nname: example-skill\ndescription: A sample skill.\n---\n\nVersion one body.\n";
	const content2 = "---\nname: example-skill\ndescription: A sample skill.\n---\n\nVersion two body.\n";
	const root = mkdtempSync(join(tmpdir(), "skill-manager-repin-"));
	try {
		const rev1 = seedUpstream(root, content1);
		const rev2 = advanceUpstream(root, content2);
		const bare = join(root, "acme", "skills.git");
		const ws = await startWorkspace({
			localContent: content1,
			identity: {
				upstreamUrl: fwd(bare),
				subpath: "skills/example-skill",
				pinnedRevision: rev1,
			},
		});
		try {
			// Freshness reports update available (pin REV1, upstream HEAD REV2).
			const fresh = await json(`${ws.base}/api/freshness?name=example-skill`);
			assert.equal(fresh.body.state, "update-available");

			// Re-pin refuses an arbitrary revision - only the resolved HEAD.
			const refused = await json(`${ws.base}/api/origin/re-pin`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "example-skill", revision: REV }),
			});
			assert.equal(refused.status, 409);
			assert.ok(String(refused.body.error).includes("upstream HEAD"));

			// Explicit re-pin to REV2 records the new pin.
			const repin = await json(`${ws.base}/api/origin/re-pin`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "example-skill", revision: rev2 }),
			});
			assert.equal(repin.status, 200);
			let manifest = parseManifest(readFileSync(ws.manifestPath, "utf-8"));
			assert.equal(
				manifest.skills["example-skill"].identity?.pinnedRevision,
				rev2,
			);

			// The review now runs against the newly pinned REV2, and apply
			// lands REV2 content in the canonical copy.
			const review = await json(`${ws.base}/api/adaptation-review`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "example-skill" }),
			});
			assert.equal(review.body.sourceRevision, rev2);
			const apply = await json(`${ws.base}/api/adaptation-review/apply`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "example-skill", review: review.body }),
			});
			assert.equal(apply.status, 200);
			assert.equal(apply.body.pushed, true);
			assert.equal(
				readFileSync(join(ws.skillDir, "SKILL.md"), "utf-8"),
				content2,
			);
			manifest = parseManifest(readFileSync(ws.manifestPath, "utf-8"));
			assert.equal(
				manifest.skills["example-skill"].identity?.pinnedRevision,
				rev2,
			);
		} finally {
			await stopChild(ws.child);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
