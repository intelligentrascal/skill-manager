import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isRepoCopyClean, scanAll } from "../src/scanner.ts";

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

test("applies provenance from skillmgr.yaml to repo records", () => {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-manifest-"));
	try {
		const skillsRoot = join(root, "skills");
		for (const name of ["vendor", "local"]) {
			const dir = join(skillsRoot, "category", name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "SKILL.md"),
				`---\ndescription: ${name}\n---\n`,
				"utf8",
			);
		}
		writeFileSync(
			join(root, "skillmgr.yaml"),
			"version: 1\nskills:\n  vendor:\n    provenance: upstream\n    identity:\n      upstreamUrl: https://example.test/skills\n      subpath: category/vendor\n      pinnedRevision: abc123\n",
			"utf8",
		);

		const inventory = scanAll({
			locations: [{ name: "repo", root: skillsRoot, nested: true }],
			manifestPath: join(root, "skillmgr.yaml"),
		});
		assert.equal(inventory.byName.vendor[0].provenance, "upstream");
		assert.equal(inventory.byName.local[0].provenance, "mine");
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
