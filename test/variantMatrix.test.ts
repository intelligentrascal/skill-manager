import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAgentVariantMatrix } from "../src/variantMatrix.ts";
import type { DiscoveryProfile } from "../src/discovery.ts";
import { defaultRegistry } from "../src/evidenceRegistry.ts";

function globalProfile(agent: DiscoveryProfile["agent"], path: string): DiscoveryProfile {
	return {
		agent,
		runtimeVersion: "test",
		evidence: "documented",
		paths: [{ path, kind: "global", exists: true }],
		precedence: ["global"],
		precedenceEvidence: "documented",
		trustRequiredKinds: [],
		notes: [],
	};
}

test("variant matrix always lists every agent as Unknown when evidence is absent", () => {
	const matrix = buildAgentVariantMatrix({
		skill: "review",
		copies: [],
		repoGitRoot: "",
		manifestRecord: undefined,
		registry: undefined,
		home: "",
		now: new Date("2026-08-16T18:00:00.000Z"),
	});

	assert.deepEqual(
		matrix.agents.map(({ agent, label, status }) => ({ agent, label, status })),
		[
			{ agent: "pi", label: "Pi", status: "Unknown" },
			{ agent: "claude", label: "Claude", status: "Unknown" },
			{ agent: "opencode", label: "OpenCode", status: "Unknown" },
			{ agent: "codex", label: "Codex", status: "Unknown" },
		],
	);
	assert.ok(matrix.agents.every((row) => row.difference === null));
	assert.ok(matrix.agents.every((row) => !/fail/i.test(row.summary)));
});

test("a runtime winner matching the repository baseline is Canonical", () => {
	const matrix = buildAgentVariantMatrix({
		skill: "review",
		copies: [
			{ location: "repo", path: "/repo/skills/review/SKILL.md", sha: "canonical-sha" },
			{ location: "pi", path: "/home/.pi/agent/skills/review/SKILL.md", sha: "canonical-sha" },
		],
		repoGitRoot: "/repo",
		manifestRecord: { provenance: "mine" },
		registry: undefined,
		profiles: { pi: globalProfile("pi", "/home/.pi/agent/skills") },
		home: "/home",
		now: new Date("2026-08-16T18:00:00.000Z"),
	});

	assert.equal(matrix.agents.find((row) => row.agent === "pi")?.status, "Canonical");
	assert.equal(matrix.agents.find((row) => row.agent === "claude")?.status, "Unknown");
});

test("a registered stored variant exposes its real canonical diff and evidence revision", () => {
	const root = mkdtempSync(join(tmpdir(), "sm-variant-matrix-"));
	try {
		const canonicalPath = join(root, "skills", "review", "SKILL.md");
		const variantPath = join(root, ".skillmgr", "variants", "review", "opencode", "SKILL.md");
		const canonical = "---\nname: review\nuser-invocable: true\n---\n\nReview.\n";
		const variant = "---\nname: review\ntriggers: auto\n---\n\nReview.\n";
		mkdirSync(join(canonicalPath, ".."), { recursive: true });
		mkdirSync(join(variantPath, ".."), { recursive: true });
		writeFileSync(canonicalPath, canonical);
		writeFileSync(variantPath, variant);

		const matrix = buildAgentVariantMatrix({
			skill: "review",
			copies: [{ location: "repo", path: canonicalPath, sha: "canonical-sha" }],
			repoGitRoot: root,
			manifestRecord: {
				provenance: "mine",
				variants: [
					{ agent: "opencode", baseRevision: "base-abc123", deployedTo: join(root, "not-deployed") },
				],
			},
			registry: defaultRegistry(),
			home: root,
			now: new Date("2026-08-16T18:00:00.000Z"),
		});

		const row = matrix.agents.find((candidate) => candidate.agent === "opencode");
		assert.equal(row?.status, "Variant stored");
		assert.deepEqual(row?.revision, {
			canonical: "base-abc123",
			agentProfile: "1.0.0",
		});
		assert.equal(row?.evidence?.level, "inferred");
		assert.ok(row?.evidence?.basis.some((claim) => claim.includes("Trigger conventions")));
		assert.match(row?.difference?.summary ?? "", /1 line added.*1 line removed/);
		assert.ok(
			row?.difference?.lines.some(
				(line) => line.kind === "removed" && line.text === "user-invocable: true",
			),
		);
		assert.ok(
			row?.difference?.lines.some(
				(line) => line.kind === "added" && line.text === "triggers: auto",
			),
		);
		assert.doesNotMatch(JSON.stringify(matrix), new RegExp(root.replaceAll("\\", "\\\\"), "i"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unregistered sidecar snapshot is not invented into a variant", () => {
	const root = mkdtempSync(join(tmpdir(), "sm-variant-matrix-unregistered-"));
	try {
		const canonicalPath = join(root, "skills", "review", "SKILL.md");
		const sidecarPath = join(root, ".skillmgr", "variants", "review", "pi", "SKILL.md");
		mkdirSync(join(canonicalPath, ".."), { recursive: true });
		mkdirSync(join(sidecarPath, ".."), { recursive: true });
		writeFileSync(canonicalPath, "---\nname: review\n---\n\nCanonical.\n");
		writeFileSync(sidecarPath, "---\nname: review\n---\n\nUnregistered change.\n");
		const matrix = buildAgentVariantMatrix({
			skill: "review",
			copies: [{ location: "repo", path: canonicalPath, sha: "canonical-sha" }],
			repoGitRoot: root,
			manifestRecord: { provenance: "mine" },
			registry: defaultRegistry(),
			home: root,
		});
		const row = matrix.agents.find((candidate) => candidate.agent === "pi");
		assert.equal(row?.status, "Unknown");
		assert.equal(row?.difference, null);
		assert.equal(row?.revision, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a registered variant with no stored snapshot stays Unknown without implying failure", () => {
	const root = mkdtempSync(join(tmpdir(), "sm-variant-matrix-missing-"));
	try {
		const canonicalPath = join(root, "skills", "review", "SKILL.md");
		mkdirSync(join(canonicalPath, ".."), { recursive: true });
		writeFileSync(canonicalPath, "---\nname: review\n---\n\nReview.\n");
		const matrix = buildAgentVariantMatrix({
			skill: "review",
			copies: [{ location: "repo", path: canonicalPath, sha: "canonical-sha" }],
			repoGitRoot: root,
			manifestRecord: {
				provenance: "mine",
				variants: [
					{ agent: "claude", baseRevision: "base-missing", deployedTo: join(root, "claude") },
				],
			},
			registry: defaultRegistry(),
			home: root,
		});
		const row = matrix.agents.find((candidate) => candidate.agent === "claude");
		assert.equal(row?.status, "Unknown");
		assert.match(row?.summary ?? "", /registered.*snapshot.*unavailable/i);
		assert.doesNotMatch(row?.summary ?? "", /fail/i);
		assert.deepEqual(row?.revision, {
			canonical: "base-missing",
			agentProfile: "1.0.0",
		});
		assert.equal(row?.difference, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a matching registered target is Deployed when runtime discovery is not evidenced", () => {
	const root = mkdtempSync(join(tmpdir(), "sm-variant-matrix-deployed-"));
	try {
		const canonicalPath = join(root, "skills", "review", "SKILL.md");
		const variantPath = join(root, ".skillmgr", "variants", "review", "codex", "SKILL.md");
		const deployedDirectory = join(root, ".codex", "skills", "review");
		const canonical = "---\nname: review\nargument-hint: path\n---\n\nReview.\n";
		const variant = "---\nname: review\n---\n\nReview.\n";
		for (const directory of [join(canonicalPath, ".."), join(variantPath, ".."), deployedDirectory]) {
			mkdirSync(directory, { recursive: true });
		}
		writeFileSync(canonicalPath, canonical);
		writeFileSync(variantPath, variant);
		writeFileSync(join(deployedDirectory, "SKILL.md"), variant);

		const matrix = buildAgentVariantMatrix({
			skill: "review",
			copies: [{ location: "repo", path: canonicalPath, sha: "canonical-sha" }],
			repoGitRoot: root,
			manifestRecord: {
				provenance: "mine",
				variants: [
					{ agent: "codex", baseRevision: "base-1", deployedTo: deployedDirectory },
				],
			},
			registry: defaultRegistry(),
			home: root,
		});

		const row = matrix.agents.find((candidate) => candidate.agent === "codex");
		assert.equal(row?.status, "Deployed");
		assert.match(row?.summary ?? "", /deployment.*observed/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a discovered deployment that passes current checks is Verified", () => {
	const root = mkdtempSync(join(tmpdir(), "sm-variant-matrix-verified-"));
	try {
		const canonicalPath = join(root, "skills", "review", "SKILL.md");
		const variantPath = join(root, ".skillmgr", "variants", "review", "pi", "SKILL.md");
		const deployedDirectory = join(root, ".pi", "agent", "skills", "review");
		const deployedPath = join(deployedDirectory, "SKILL.md");
		const canonical = "---\nname: review\nuser-invocable: true\n---\n\nReview.\n";
		const variant = "---\nname: review\n---\n\nReview.\n";
		for (const directory of [join(canonicalPath, ".."), join(variantPath, ".."), deployedDirectory]) {
			mkdirSync(directory, { recursive: true });
		}
		writeFileSync(canonicalPath, canonical);
		writeFileSync(variantPath, variant);
		writeFileSync(deployedPath, variant);
		const variantSha = createHash("sha256").update(variant).digest("hex");

		const matrix = buildAgentVariantMatrix({
			skill: "review",
			copies: [
				{ location: "repo", path: canonicalPath, sha: "canonical-sha" },
				{ location: "pi", path: deployedPath, sha: variantSha },
			],
			repoGitRoot: root,
			manifestRecord: {
				provenance: "mine",
				variants: [
					{ agent: "pi", baseRevision: "base-1", deployedTo: deployedDirectory },
				],
			},
			registry: defaultRegistry(),
			profiles: { pi: globalProfile("pi", "~/.pi/agent/skills") },
			home: root,
		});

		const row = matrix.agents.find((candidate) => candidate.agent === "pi");
		assert.equal(row?.status, "Verified");
		assert.match(row?.summary ?? "", /re-verified.*discovery/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
