import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parseManifest } from "../src/manifest.ts";
import test from "node:test";
import { listen, reservePort, stopChild, waitForServer } from "./workspaceServer.ts";

const SKILL = "---\nname: public-skill\ndescription: Public test skill.\n---\n\nTest.\n";

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

test("origin HTTP API reads cached GitHub facts and refreshes only on explicit POST", async () => {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-origin-workspace-"));
	const repoSkills = join(root, "agent-skills", "skills");
	const skillDir = join(repoSkills, "misc", "public-skill");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), SKILL);
	for (const name of ["private-skill", "local-skill", "unknown-skill"]) {
		const directory = join(repoSkills, "misc", name);
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, "SKILL.md"),
			SKILL.replaceAll("public-skill", name),
		);
	}
	writeFileSync(join(root, "agent-skills", "skillmgr.yaml"), `version: 1
skills:
  public-skill:
    provenance: upstream
    identity:
      upstreamUrl: https://github.com/acme/skills.git
      subpath: skills/public-skill
      pinnedRevision: abc123
    origin:
      current:
        type: github
        at: 2026-08-16T15:43:00.000Z
        reason: imported from upstream
        verifiedAt: 2026-08-16T15:43:00.000Z
  private-skill:
    provenance: upstream
    origin:
      current:
        type: private
        at: 2026-08-16T15:43:00.000Z
        reason: community source
        attribution: Internal community
  local-skill:
    provenance: mine
    origin:
      current:
        type: local
        at: 2026-08-16T15:43:00.000Z
        reason: written locally
        ownershipNote: Maintained by me
`);

	let githubRequests = 0;
	const github = createServer((_request, response) => {
		githubRequests += 1;
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({
			name: "skills",
			html_url: "https://github.com/acme/skills",
			stargazers_count: 418,
			owner: {
				login: "acme",
				avatar_url: "https://avatars.githubusercontent.com/u/42?v=4",
			},
		}));
	});
	const githubPort = await listen(github);
	const appPort = await reservePort();
	const empty = join(root, "empty");
	mkdirSync(empty, { recursive: true });
	let output = "";
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "src/server.ts"],
		{
			cwd: process.cwd(),
			// POSIX process-group leader so killTree can SIGKILL the whole tree.
			detached: process.platform !== "win32",
			env: {
				...process.env,
				SM_PORT: String(appPort),
				SM_PI_SKILLS: empty,
				SM_OPENCODE_SKILLS: empty,
				SM_CLAUDE_SKILLS: empty,
				SM_SHARED_SKILLS: empty,
				SM_REPO_SKILLS: repoSkills,
				SM_CACHE_DIR: join(root, "cache"),
				SM_GITHUB_API_BASE: `http://127.0.0.1:${githubPort}`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	child.stdout?.on("data", (chunk) => { output += String(chunk); });
	child.stderr?.on("data", (chunk) => { output += String(chunk); });
	const base = `http://127.0.0.1:${appPort}`;

	try {
		await waitForServer(`${base}/`, child, () => output);
		const before = await fetch(`${base}/api/origin?name=public-skill`);
		assert.equal(before.status, 200);
		const beforeBody = await before.json();
		assert.equal(beforeBody.state, "github");
		assert.equal(beforeBody.githubMetadata, null);
		assert.equal(githubRequests, 0, "page reads must not contact GitHub");

		const refresh = await fetch(`${base}/api/origin/refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "public-skill" }),
		});
		assert.equal(refresh.status, 200);
		const refreshed = await refresh.json();
		assert.equal(refreshed.githubMetadata.stars, 418);
		assert.equal(refreshed.githubMetadata.ownerLogin, "acme");
		assert.ok(Date.parse(refreshed.githubMetadata.verifiedAt));
		assert.equal(githubRequests, 1);

		const cached = await fetch(`${base}/api/origin?name=public-skill`);
		assert.equal(cached.status, 200);
		const cachedBody = await cached.json();
		assert.deepEqual(cachedBody.githubMetadata, refreshed.githubMetadata);
		assert.equal(githubRequests, 1, "cached reads must not poll GitHub");

		for (const [name, state] of [
			["private-skill", "private"],
			["local-skill", "local"],
			["unknown-skill", "unknown"],
		]) {
			const honest = await fetch(`${base}/api/origin?name=${name}`);
			assert.equal(honest.status, 200);
			const body = await honest.json();
			assert.equal(body.state, state);
			assert.equal(body.identity, null);
			assert.equal(body.githubMetadata, null);

			const rejected = await fetch(`${base}/api/origin/refresh`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name }),
			});
			assert.equal(rejected.status, 409);
		}
		assert.equal(githubRequests, 1, "non-public origins must never contact GitHub");
	} finally {
		await stopChild(child);
		await new Promise<void>((resolve) => github.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});

test("HTTP assignment flow previews, assigns, commits, and pushes with the verified name recorded", async () => {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-origin-assign-flow-"));
	const remote = join(root, "remote.git");
	const repo = join(root, "agent-skills");
	const repoSkills = join(repo, "skills");
	const skillDir = join(repoSkills, "misc", "public-skill");
	let child: ChildProcess | undefined;
	try {
		initBare(remote);
		initRepo(repo, remote);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), SKILL);
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "base"]);
		git(repo, ["push", "-u", "origin", "main"]);
		writeFileSync(join(repo, "skillmgr.yaml"), "version: 1\nskills:\n  public-skill:\n    provenance: mine\n");

		const appPort = await reservePort();
		const empty = join(root, "empty");
		mkdirSync(empty, { recursive: true });
		let output = "";
		child = spawn(
			process.execPath,
			["--experimental-strip-types", "src/server.ts"],
			{
				cwd: process.cwd(),
				// POSIX process-group leader so killTree can SIGKILL the whole tree.
				detached: process.platform !== "win32",
				env: {
					...process.env,
					SM_PORT: String(appPort),
					SM_PI_SKILLS: empty,
					SM_OPENCODE_SKILLS: empty,
					SM_CLAUDE_SKILLS: empty,
					SM_SHARED_SKILLS: empty,
					SM_REPO_SKILLS: repoSkills,
					SM_CACHE_DIR: join(root, "cache"),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		child.stdout?.on("data", (chunk) => { output += String(chunk); });
		child.stderr?.on("data", (chunk) => { output += String(chunk); });
		const base = `http://127.0.0.1:${appPort}`;

		await waitForServer(`${base}/`, child, () => output);

		// A local-assignment preview is still gated on a reason (enforcement).
		const gated = await fetch(`${base}/api/origin/preview`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "public-skill",
				origin: { type: "local" },
			}),
		});
		assert.equal(gated.status, 409);

		// The full flow: preview then assign (which commits and pushes).
		const previewResponse = await fetch(`${base}/api/origin/preview`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "public-skill",
				category: "misc",
				origin: { type: "local", reason: "I wrote this", ownershipNote: "scratch" },
				sourcePath: join(repoSkills, "misc", "public-skill", "SKILL.md"),
			}),
		});
		assert.equal(previewResponse.status, 200);
		const preview = await previewResponse.json();
		assert.equal(preview.contentSha.length, 64);
		assert.equal(preview.provenance, "mine");

		const assignResponse = await fetch(`${base}/api/origin/assign`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "public-skill",
				category: "misc",
				origin: { type: "local", reason: "I wrote this", ownershipNote: "scratch" },
				expectedContentSha: preview.contentSha,
				sourcePath: join(repoSkills, "misc", "public-skill", "SKILL.md"),
			}),
		});
		assert.equal(assignResponse.status, 200);
		const result = await assignResponse.json();
		assert.equal(result.committed, true);
		assert.equal(result.pushed, true);
		assert.ok(result.commitSha);

		// The remote received the commit and the manifest carries the origin.
		assert.equal(git(remote, ["rev-parse", "main"]), result.commitSha);
		const manifest = parseManifest(
			readFileSync(join(repo, "skillmgr.yaml"), "utf8"),
		);
		assert.equal(manifest.skills["public-skill"].origin!.current.type, "local");
		assert.equal(manifest.skills["public-skill"].origin!.current.reason, "I wrote this");
	} finally {
		if (child !== undefined) await stopChild(child);
		rmSync(root, { recursive: true, force: true });
	}
});
