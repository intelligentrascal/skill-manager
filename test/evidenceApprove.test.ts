import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRegistry } from "../src/evidenceRegistry.ts";
import { checkRegistrySources, type FetchResult } from "../src/evidenceCheck.ts";
import {
	approveProposal,
	ApprovalError,
} from "../src/evidenceApprove.ts";
import {
	readActiveRegistry,
	registryPaths,
	writeActiveRegistry,
	writeProposal,
} from "../src/evidenceStore.ts";

const sha = (text: string) =>
	createHash("sha256").update(text).digest("hex");

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(): { root: string; bare: string } {
	const base = mkdtempSync(join(tmpdir(), "sm-evidence-approve-"));
	const root = join(base, "repo");
	const bare = join(base, "remote.git");
	mkdirSync(root, { recursive: true });
	git(root, ["init", "--initial-branch=main"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "Test"]);
	execFileSync("git", ["init", "--bare", bare]);
	git(root, ["remote", "add", "origin", bare]);
	// initial commit so HEAD exists and origin/main has a base
	writeFileSync(join(root, "README.md"), "initial\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "initial"]);
	git(root, ["push", "origin", "main"]);
	return { root, bare };
}

function seedRegistryAndProposal(
	root: string,
	content: string,
): { proposalId: string; registryVersion: string } {
	const registry = defaultRegistry();
	writeActiveRegistry(registryPaths(root).activeRegistryPath, registry);
	git(root, ["add", ".skillmgr"]);
	git(root, ["commit", "-m", "seed registry"]);
	const fetchFn = async (): Promise<FetchResult> => ({ ok: true, text: content });
	return checkRegistrySources(registry, fetchFn, {
		createdBy: "manual-check",
		id: "p1",
		now: new Date("2026-08-16T10:00:00.000Z"),
	}).then((proposal) => {
		writeProposal(registryPaths(root).attentionDir, proposal);
		return { proposalId: proposal.id, registryVersion: registry.registryVersion };
	});
}

test("approve re-baselines sources, commits, and pushes to origin (AC4)", async () => {
	const { root, bare } = initRepo();
	try {
		const { proposalId } = await seedRegistryAndProposal(root, "spec content v1");
		const result = await approveProposal({
			repoRoot: root,
			proposalId,
			now: new Date("2026-08-16T10:05:00.000Z"),
		});
		assert.equal(result.pushed, true);
		assert.equal(result.registryVersion, "1.0.1");
		assert.ok(result.commitSha.length === 40, "has a commit");
		assert.ok(result.rebaselinedSources >= 1);

		// active registry is updated on disk
		const active = readActiveRegistry(registryPaths(root).activeRegistryPath);
		assert.equal(active.registryVersion, "1.0.1");
		const piSpec = active.profiles.pi.sources.find((s) => s.fetchable);
		assert.ok(piSpec);
		assert.equal(piSpec.contentHash, sha("spec content v1"));

		// the push landed on the bare remote
		const remoteHead = execFileSync("git", ["rev-parse", "main"], {
			cwd: bare,
			encoding: "utf-8",
		}).trim();
		assert.equal(remoteHead, result.commitSha);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a proposal does not change the active registry until approved (AC3)", async () => {
	const { root } = initRepo();
	try {
		const paths = registryPaths(root);
		writeActiveRegistry(paths.activeRegistryPath, defaultRegistry());
		const before = readFileSync(paths.activeRegistryPath, "utf-8");

		const registry = readActiveRegistry(paths.activeRegistryPath);
		const fetchFn = async (): Promise<FetchResult> => ({ ok: true, text: "new" });
		const proposal = await checkRegistrySources(registry, fetchFn, {
			createdBy: "manual-check",
			id: "p-ac3",
			now: new Date("2026-08-16T10:00:00.000Z"),
		});
		writeProposal(paths.attentionDir, proposal);

		// creating + storing the proposal must leave the active registry byte-identical
		assert.equal(readFileSync(paths.activeRegistryPath, "utf-8"), before);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("approve on a changed (non-baseline) source updates its hash", async () => {
	const { root } = initRepo();
	try {
		const paths = registryPaths(root);
		const registry = defaultRegistry();
		registry.profiles.pi.sources[0].contentHash = sha("old");
		writeActiveRegistry(paths.activeRegistryPath, registry);
		git(root, ["add", ".skillmgr"]);
		git(root, ["commit", "-m", "seed"]);

		const fetchFn = async (): Promise<FetchResult> => ({
			ok: true,
			text: "completely new",
		});
		const proposal = await checkRegistrySources(registry, fetchFn, {
			createdBy: "manual-check",
			id: "p-changed",
			now: new Date("2026-08-16T10:00:00.000Z"),
		});
		writeProposal(paths.attentionDir, proposal);

		const result = await approveProposal({ repoRoot: root, proposalId: "p-changed" });
		assert.equal(result.pushed, true);
		const active = readActiveRegistry(paths.activeRegistryPath);
		assert.equal(active.profiles.pi.sources[0].contentHash, sha("completely new"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed push preserves the local commit and reports the failure", async () => {
	const { root } = initRepo();
	try {
		const { proposalId } = await seedRegistryAndProposal(root, "spec content v1");
		// break the remote so the push must fail
		git(root, ["remote", "remove", "origin"]);
		const result = await approveProposal({
			repoRoot: root,
			proposalId,
			now: new Date("2026-08-16T10:05:00.000Z"),
		});
		assert.equal(result.pushed, false);
		assert.ok(result.pushError, "reports the push error");
		assert.ok(result.commitSha.length === 40, "local commit still exists");
		// the local commit is retryable: HEAD is the new registry revision
		assert.equal(
			readActiveRegistry(registryPaths(root).activeRegistryPath).registryVersion,
			"1.0.1",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("approving a proposal with nothing to re-baseline is rejected", async () => {
	const { root } = initRepo();
	try {
		const paths = registryPaths(root);
		writeActiveRegistry(paths.activeRegistryPath, defaultRegistry());
		writeProposal(paths.attentionDir, {
			id: "p-empty",
			createdAt: "2026-08-16T10:00:00.000Z",
			createdBy: "manual-check",
			baseRegistryVersion: "1.0.0",
			status: "pending",
			checks: [],
			changedCount: 0,
			unreachableCount: 0,
			blockedCount: 0,
			summary: "nothing changed",
		});
		await assert.rejects(
			approveProposal({ repoRoot: root, proposalId: "p-empty" }),
			ApprovalError,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
