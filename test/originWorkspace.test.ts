import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SKILL = "---\nname: public-skill\ndescription: Public test skill.\n---\n\nTest.\n";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
	return await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") reject(new Error("missing test port"));
			else resolve(address.port);
		});
	});
}

async function reservePort(): Promise<number> {
	const server = createServer();
	const port = await listen(server);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

async function waitForServer(url: string, child: ChildProcess, logs: () => string): Promise<void> {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`server exited before readiness\n${logs()}`);
		}
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`server did not become ready\n${logs()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return;
	child.kill();
	await Promise.race([
		new Promise<void>((resolve) => child.once("exit", () => resolve())),
		new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
	]);
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
