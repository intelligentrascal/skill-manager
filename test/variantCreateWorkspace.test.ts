import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A canonical skill with a frontmatter block: adaptation is supported.
const CANONICAL =
	"---\nname: create-me\ndescription: Skill to adapt.\nuser-invocable: true\n---\n\nBody.\n";
// A skill with no frontmatter block: adaptation is blocked, creation must fail.
const BLOCKED = "# Raw notes\n\nNo frontmatter block here.\n";

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
		if (child.exitCode !== null) throw new Error(`server exited before readiness\n${logs()}`);
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch (error) {
			// server not up yet - poll again
			void error;
		}
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

test("variant creation stores the adapted snapshot, registers it, and updates the matrix", async () => {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-variant-create-"));
	const repoRoot = join(root, "agent-skills");
	const repoSkills = join(repoRoot, "skills");
	const canonicalDirectory = join(repoSkills, "misc", "create-me");
	mkdirSync(canonicalDirectory, { recursive: true });
	writeFileSync(join(canonicalDirectory, "SKILL.md"), CANONICAL);
	writeFileSync(
		join(repoRoot, "skillmgr.yaml"),
		`version: 1\nskills:\n  create-me:\n    provenance: mine\n`,
	);
	const empty = join(root, "empty");
	mkdirSync(empty, { recursive: true });
	const port = await reservePort();
	let output = "";
	const child = spawn(process.execPath, ["--experimental-strip-types", "src/server.ts"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOME: root,
			USERPROFILE: root,
			SM_PORT: String(port),
			SM_PI_SKILLS: empty,
			SM_OPENCODE_SKILLS: empty,
			SM_CLAUDE_SKILLS: empty,
			SM_SHARED_SKILLS: empty,
			SM_REPO_SKILLS: repoSkills,
			SM_EVIDENCE_REGISTRY_ROOT: repoRoot,
			SM_CACHE_DIR: join(root, "cache"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", (chunk) => { output += String(chunk); });
	child.stderr?.on("data", (chunk) => { output += String(chunk); });
	const base = `http://127.0.0.1:${port}`;

	try {
		await waitForServer(`${base}/`, child, () => output);

		// Before creation the matrix row is Unknown with a create affordance.
		const before = await (await fetch(`${base}/api/variant-matrix?name=create-me`)).json();
		const beforePi = before.agents.find((row: { agent: string }) => row.agent === "pi");
		assert.equal(beforePi.status, "Unknown");
		assert.equal(beforePi.createSupported, true);

		// Create the pi variant: adapted snapshot + manifest registration.
		const createResponse = await fetch(`${base}/api/variant`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "create-me", agent: "pi" }),
		});
		assert.equal(createResponse.status, 200);
		const created = await createResponse.json();
		assert.equal(created.skill, "create-me");
		assert.equal(created.agent, "pi");
		assert.ok(created.adapt.removed.includes("user-invocable"));

		// The sidecar snapshot exists and is adapted, not a guessed copy.
		const stored = readFileSync(
			join(repoRoot, ".skillmgr", "variants", "create-me", "pi", "SKILL.md"),
			"utf-8",
		);
		assert.ok(stored.includes("Body."));
		assert.ok(!stored.includes("user-invocable"));

		// The variant is registered in the sidecar store (variant.json next to
		// the snapshot) with the empty-path convention for not-deployed, and the
		// committed skillmgr.yaml is left untouched.
		const registration = JSON.parse(
			readFileSync(
				join(repoRoot, ".skillmgr", "variants", "create-me", "pi", "variant.json"),
				"utf-8",
			),
		) as { skill?: unknown; agent?: unknown; baseRevision?: unknown; deployedTo?: unknown };
		assert.equal(registration.skill, "create-me");
		assert.equal(registration.agent, "pi");
		assert.equal(typeof registration.baseRevision, "string");
		assert.equal(registration.deployedTo, "");
		assert.equal(
			readFileSync(join(repoRoot, "skillmgr.yaml"), "utf-8"),
			`version: 1\nskills:\n  create-me:\n    provenance: mine\n`,
			"creation must not modify the committed provenance manifest",
		);

		// The matrix now reports the stored variant for pi.
		const after = await (await fetch(`${base}/api/variant-matrix?name=create-me`)).json();
		const afterPi = after.agents.find((row: { agent: string }) => row.agent === "pi");
		assert.equal(afterPi.status, "Variant stored");
		assert.equal(afterPi.createSupported, false);
	} finally {
		await stopChild(child);
		rmSync(root, { recursive: true, force: true });
	}
});

test("variant creation is blocked for unsupported mappings and writes nothing", async () => {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-variant-blocked-"));
	const repoRoot = join(root, "agent-skills");
	const repoSkills = join(repoRoot, "skills");
	const canonicalDirectory = join(repoSkills, "misc", "raw-notes");
	mkdirSync(canonicalDirectory, { recursive: true });
	writeFileSync(join(canonicalDirectory, "SKILL.md"), BLOCKED);
	const empty = join(root, "empty");
	mkdirSync(empty, { recursive: true });
	const port = await reservePort();
	let output = "";
	const child = spawn(process.execPath, ["--experimental-strip-types", "src/server.ts"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOME: root,
			USERPROFILE: root,
			SM_PORT: String(port),
			SM_PI_SKILLS: empty,
			SM_OPENCODE_SKILLS: empty,
			SM_CLAUDE_SKILLS: empty,
			SM_SHARED_SKILLS: empty,
			SM_REPO_SKILLS: repoSkills,
			SM_EVIDENCE_REGISTRY_ROOT: repoRoot,
			SM_CACHE_DIR: join(root, "cache"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", (chunk) => { output += String(chunk); });
	child.stderr?.on("data", (chunk) => { output += String(chunk); });
	const base = `http://127.0.0.1:${port}`;

	try {
		await waitForServer(`${base}/`, child, () => output);

		// The matrix row explains the block and offers no create action.
		const before = await (await fetch(`${base}/api/variant-matrix?name=raw-notes`)).json();
		const beforePi = before.agents.find((row: { agent: string }) => row.agent === "pi");
		assert.equal(beforePi.status, "Unknown");
		assert.equal(beforePi.createSupported, false);
		assert.match(beforePi.reason ?? "", /no variant snapshot registered/i);

		// Creation is refused - blocked, not guessed.
		const createResponse = await fetch(`${base}/api/variant`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "raw-notes", agent: "pi" }),
		});
		assert.equal(createResponse.status, 409);
		const blocked = await createResponse.json();
		assert.match(blocked.error ?? "", /cannot adapt automatically/i);

		// Nothing was written to the sidecar store.
		assert.equal(
			existsSync(join(repoRoot, ".skillmgr", "variants", "raw-notes")),
			false,
			"blocked creation must not write a sidecar snapshot",
		);
	} finally {
		await stopChild(child);
		rmSync(root, { recursive: true, force: true });
	}
});
