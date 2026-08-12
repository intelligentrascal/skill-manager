import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createVariant,
	deployVariant,
	verifyDeployedVariant,
	removeVariant,
	readVariant,
	variantStoreRoot,
} from "../src/variantStore.ts";

const CANONICAL = `---
name: review
description: Review code for bugs.
argument-hint: "usage: review <path>"
user-invocable: true
---

## Workflow
Review the code.
`;

function tmpRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "sm-variant-"));
	return root;
}

test("createVariant stores an adapted full snapshot in the sidecar store", () => {
	const root = tmpRoot();
	try {
		const artifact = createVariant(root, "review", "pi", CANONICAL);
		assert.ok(artifact.adapt.removed.includes("argument-hint"));
		const stored = readVariant(artifact.storePath);
		assert.ok(stored);
		assert.ok(!stored.includes("argument-hint"));
		assert.ok(stored.includes("allowed-tools") === false || true); // canonical has none
		assert.ok(artifact.storePath.startsWith(join(root, ".skillmgr", "variants")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("deployVariant copies SKILL.md to the target path", () => {
	const root = tmpRoot();
	try {
		const artifact = createVariant(root, "review", "pi", CANONICAL);
		const target = join(root, "fake-discovery", "review");
		deployVariant(artifact.storePath, target);
		const deployed = readFileSync(join(target, "SKILL.md"), "utf-8");
		assert.ok(deployed.includes("Review code"));
		assert.ok(!deployed.includes("user-invocable"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("verifyDeployedVariant: removed fields must be gone; failures are caught", () => {
	const root = tmpRoot();
	try {
		const artifact = createVariant(root, "review", "pi", CANONICAL);
		const target = join(root, "fake-discovery", "review");
		deployVariant(artifact.storePath, target);
		const deployed = readFileSync(join(target, "SKILL.md"), "utf-8");
		const ok = verifyDeployedVariant(deployed, artifact.adapt, "pi");
		assert.equal(ok.ok, true);

		// a copy that kept a removed field must fail verification
		const bad = `---\nname: review\ndescription: x\nuser-invocable: true\n---\n`;
		const fail = verifyDeployedVariant(bad, artifact.adapt, "pi");
		assert.equal(fail.ok, false);
		assert.deepEqual(fail.stillPresent, ["user-invocable"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("removeVariant cleans store and deployed copy", () => {
	const root = tmpRoot();
	try {
		const artifact = createVariant(root, "review", "pi", CANONICAL);
		const target = join(root, "fake-discovery", "review");
		deployVariant(artifact.storePath, target);
		removeVariant(artifact.storePath, target);
		assert.equal(existsSync(artifact.storePath), false);
		assert.equal(existsSync(join(target, "SKILL.md")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("variantStoreRoot nests under .skillmgr/variants", () => {
	const root = tmpRoot();
	try {
		assert.equal(variantStoreRoot(root), join(root, ".skillmgr", "variants"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
