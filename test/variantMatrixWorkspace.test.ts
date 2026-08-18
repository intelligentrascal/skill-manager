import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reservePort, stopChild, waitForServer } from "./workspaceServer.ts";

const CANONICAL = "---\nname: review\ndescription: Review changes.\nuser-invocable: true\n---\n\nReview.\n";
const PI_VARIANT = "---\nname: review\ndescription: Review changes.\n---\n\nReview.\n";

test("variant matrix HTTP API returns honest status, diff, and evidence without machine paths", async () => {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-variant-workspace-"));
	const repoRoot = join(root, "agent-skills");
	const repoSkills = join(repoRoot, "skills");
	const canonicalDirectory = join(repoSkills, "misc", "review");
	const variantDirectory = join(repoRoot, ".skillmgr", "variants", "review", "pi");
	const piDirectory = join(root, ".pi", "agent", "skills", "review");
	for (const directory of [canonicalDirectory, variantDirectory, piDirectory]) {
		mkdirSync(directory, { recursive: true });
	}
	writeFileSync(join(canonicalDirectory, "SKILL.md"), CANONICAL);
	writeFileSync(join(variantDirectory, "SKILL.md"), PI_VARIANT);
	writeFileSync(join(piDirectory, "SKILL.md"), PI_VARIANT);
	writeFileSync(
		join(repoRoot, "skillmgr.yaml"),
		`version: 1\nskills:\n  review:\n    provenance: mine\n    variants:\n      - agent: pi\n        baseRevision: canonical-1\n        deployedTo: ${piDirectory.replaceAll("\\", "/")}\n`,
	);
	const empty = join(root, "empty");
	mkdirSync(empty, { recursive: true });
	const port = await reservePort();
	let output = "";
	const child = spawn(process.execPath, ["--experimental-strip-types", "src/server.ts"], {
		cwd: process.cwd(),
		// POSIX process-group leader so killTree can SIGKILL the whole tree.
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
		const response = await fetch(`${base}/api/variant-matrix?name=review`);
		assert.equal(response.status, 200);
		const raw = await response.text();
		const matrix = JSON.parse(raw);
		assert.deepEqual(
			matrix.agents.map((row: { label: string }) => row.label),
			["Pi", "Claude", "OpenCode", "Codex"],
		);
		assert.equal(matrix.agents[0].status, "Verified");
		assert.equal(matrix.agents[0].revision.agentProfile, "1.0.0");
		assert.ok(matrix.agents[0].difference.lines.some(
			(line: { kind: string; text: string }) =>
				line.kind === "removed" && line.text === "user-invocable: true",
		));
		assert.ok(matrix.agents.slice(1).every((row: { status: string }) => row.status === "Unknown"));
		assert.equal(raw.toLowerCase().includes(root.replaceAll("\\", "/").toLowerCase()), false);
		assert.equal(raw.toLowerCase().includes(root.toLowerCase()), false);
	} finally {
		await stopChild(child);
		rmSync(root, { recursive: true, force: true });
	}
});
