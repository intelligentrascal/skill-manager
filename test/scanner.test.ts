import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isRepoCopyClean } from "../src/scanner.ts";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("uses git status rather than byte hashes for repo cleanliness", () => {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-git-"));
	try {
		const skill = join(root, "skills", "testing", "sample", "SKILL.md");
		mkdirSync(join(root, "skills", "testing", "sample"), { recursive: true });
		writeFileSync(skill, "---\nname: sample\n---\nhello\n", "utf-8");
		git(root, "init");
		git(root, "config", "user.email", "test@example.com");
		git(root, "config", "user.name", "Test User");
		git(root, "add", ".");
		git(root, "commit", "-m", "initial");

		assert.equal(isRepoCopyClean(root, skill), true);
		writeFileSync(skill, "---\nname: sample\n---\nchanged\n", "utf-8");
		assert.equal(isRepoCopyClean(root, skill), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("marks an untracked repo skill as dirty", () => {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-git-"));
	try {
		git(root, "init");
		git(root, "config", "user.email", "test@example.com");
		git(root, "config", "user.name", "Test User");
		writeFileSync(join(root, "README.md"), "initial\n", "utf-8");
		git(root, "add", "README.md");
		git(root, "commit", "-m", "initial");
		const skill = join(root, "skills", "testing", "new-skill", "SKILL.md");
		mkdirSync(join(root, "skills", "testing", "new-skill"), {
			recursive: true,
		});
		writeFileSync(skill, "---\nname: new-skill\n---\nnew\n", "utf-8");

		assert.equal(isRepoCopyClean(root, skill), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
