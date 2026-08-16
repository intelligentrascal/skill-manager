import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRegistry } from "../src/evidenceRegistry.ts";
import {
	listProposals,
	readActiveRegistry,
	readProposal,
	registryPaths,
	writeActiveRegistry,
	writeProposal,
	RegistryReadError,
} from "../src/evidenceStore.ts";
import type { RegistryProposal } from "../src/evidenceCheck.ts";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "sm-evidence-store-"));
}

const PROPOSAL: RegistryProposal = {
	id: "p1",
	createdAt: "2026-08-16T10:00:00.000Z",
	createdBy: "manual-check",
	baseRegistryVersion: "1.0.0",
	status: "pending",
	checks: [],
	changedCount: 0,
	unreachableCount: 0,
	blockedCount: 0,
	summary: "nothing",
};

test("active registry round-trips through disk", () => {
	const root = tmp();
	try {
		const paths = registryPaths(root);
		writeActiveRegistry(paths.activeRegistryPath, defaultRegistry());
		const read = readActiveRegistry(paths.activeRegistryPath);
		assert.equal(read.registryVersion, "1.0.0");
		assert.equal(read.profiles.pi.observedVersion, "0.84.1");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a missing registry falls back to the seed", () => {
	const root = tmp();
	try {
		const paths = registryPaths(root);
		assert.equal(
			readActiveRegistry(paths.activeRegistryPath).registryVersion,
			"1.0.0",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an invalid on-disk registry throws instead of silently reverting", () => {
	const root = tmp();
	try {
		const paths = registryPaths(root);
		mkdirSync(join(root, ".skillmgr"), { recursive: true });
		writeFileSync(paths.activeRegistryPath, "{ not json", "utf-8");
		assert.throws(
			() => readActiveRegistry(paths.activeRegistryPath),
			RegistryReadError,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("proposals list, read, and round-trip", () => {
	const root = tmp();
	try {
		const paths = registryPaths(root);
		assert.deepEqual(listProposals(paths.attentionDir), []);
		writeProposal(paths.attentionDir, PROPOSAL);
		assert.equal(listProposals(paths.attentionDir).length, 1);
		assert.equal(readProposal(paths.attentionDir, "p1")?.id, "p1");
		assert.equal(readProposal(paths.attentionDir, "missing"), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
