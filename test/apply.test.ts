import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	existsSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	VerifiedApplyService,
	ApplyError,
	type ApplyGit,
	type ApplyTarget,
} from "../src/apply.ts";
import type {
	AdaptationReview,
	AgentAdaptationProposal,
} from "../src/adaptationReview.ts";
import { adaptSkill } from "../src/variant.ts";
import { readableDifference } from "../src/diff.ts";
import { parseManifest } from "../src/manifest.ts";
import type { AgentId } from "../src/compat.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NEW_CANONICAL =
	"---\nname: review\ndescription: New canonical.\nuser-invocable: true\nmodel: gpt-5\n---\nNew body.\n";
const OLD_CANONICAL =
	"---\nname: review\ndescription: Old canonical.\n---\nOld body.\n";

function tmpRoot(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

/** A repo-like dir (no git) with a skill + a valid provenance manifest. */
function initApplyRepo(): { root: string; skill: string } {
	const root = tmpRoot("sm-apply-");
	const skill = "review";
	const skillDir = join(root, "skills", "misc", skill);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), OLD_CANONICAL);
	const manifest =
		"version: 1\n" +
		"skills:\n" +
		"  review:\n" +
		"    provenance: upstream\n" +
		"    identity:\n" +
		"      upstreamUrl: https://github.com/example/review.git\n" +
		"      subpath: SKILL.md\n" +
		"      pinnedRevision: old-rev\n";
	writeFileSync(join(root, "skillmgr.yaml"), manifest);
	return { root, skill };
}

/** A real git repo with a bare remote, seeded with the skill + manifest. */
function initGitRepo(): { root: string; bare: string; skill: string } {
	const base = tmpRoot("sm-apply-git-");
	const root = join(base, "repo");
	mkdirSync(root, { recursive: true });
	git(root, ["init", "--initial-branch=main"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "Test"]);
	const bare = join(base, "remote.git");
	execFileSync("git", ["init", "--bare", bare]);
	git(root, ["remote", "add", "origin", bare]);

	const skill = "review";
	const skillDir = join(root, "skills", "misc", skill);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), OLD_CANONICAL);
	const manifest =
		"version: 1\n" +
		"skills:\n" +
		"  review:\n" +
		"    provenance: upstream\n" +
		"    identity:\n" +
		"      upstreamUrl: https://github.com/example/review.git\n" +
		"      subpath: SKILL.md\n" +
		"      pinnedRevision: old-rev\n";
	writeFileSync(join(root, "skillmgr.yaml"), manifest);
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "seed"]);
	git(root, ["push", "origin", "main"]);
	return { root, bare, skill };
}

function proposedAgent(agent: AgentId, upstream: string): AgentAdaptationProposal {
	const adapt = adaptSkill(upstream, agent);
	return {
		agent,
		label: agent,
		status: "proposed",
		impact: [],
		proposed: {
			content: adapt.content,
			diff: readableDifference(upstream, adapt.content),
			removed: adapt.removed,
			added: adapt.added,
			carryOver: adapt.carryOver,
		},
		evidence: {
			level: "documented",
			observedVersion: "x",
			observedAt: "x",
			basis: [],
		},
		uncertainty: [],
		blockingConditions: [],
	};
}

function canonicalAgent(agent: AgentId): AgentAdaptationProposal {
	return {
		agent,
		label: agent,
		status: "canonical",
		impact: [],
		proposed: null,
		evidence: {
			level: "documented",
			observedVersion: "x",
			observedAt: "x",
			basis: [],
		},
		uncertainty: [],
		blockingConditions: [],
	};
}

function blockedAgent(agent: AgentId): AgentAdaptationProposal {
	return {
		agent,
		label: agent,
		status: "blocked",
		impact: [],
		proposed: null,
		evidence: {
			level: "documented",
			observedVersion: "x",
			observedAt: "x",
			basis: [],
		},
		uncertainty: [],
		blockingConditions: ["intentional block for the test"],
	};
}

function makeReview(
	skill: string,
	agents: AgentAdaptationProposal[],
	canonicalRevision = "new-rev",
): AdaptationReview {
	return {
		skill,
		generatedAt: "2026-08-16T00:00:00.000Z",
		sourceRevision: canonicalRevision,
		canonicalRevision: "base-rev",
		agentProfileRevision: "1.0.0",
		cacheKey: "k",
		cacheHit: false,
		changeSummary: {
			sourceRevision: canonicalRevision,
			canonicalRevision: "base-rev",
			changedFields: [],
			bodyChanged: false,
			addedLines: 0,
			removedLines: 0,
			summary: "",
		},
		agents,
	};
}

function readTarget(target: ApplyTarget): string {
	return readFileSync(join(target.path, "review", "SKILL.md"), "utf-8");
}

// ---------------------------------------------------------------------------
// Fake git (records the transaction order)
// ---------------------------------------------------------------------------

class RecorderGit implements ApplyGit {
	calls: string[] = [];
	private readonly pushOk: boolean;
	constructor(pushOk = true) {
		this.pushOk = pushOk;
	}
	async add(): Promise<void> {
		this.calls.push("add");
	}
	async commit(): Promise<string> {
		this.calls.push("commit");
		return "a".repeat(40);
	}
	async push(): Promise<{ pushed: boolean; error?: string }> {
		this.calls.push("push");
		return this.pushOk ? { pushed: true } : { pushed: false, error: "rejected" };
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("AC1+AC2: approval stages, deploys, verifies, commits and pushes one managed revision", async () => {
	const { root, skill } = initApplyRepo();
	try {
		const codexTarget: ApplyTarget = { agent: "codex", path: join(root, "t-codex") };
		const claudeTarget: ApplyTarget = { agent: "claude", path: join(root, "t-claude") };
		const piTarget: ApplyTarget = { agent: "pi", path: join(root, "t-pi") };

		const review = makeReview(skill, [
			proposedAgent("codex", NEW_CANONICAL),
			canonicalAgent("claude"),
			blockedAgent("pi"),
		]);

		const service = new VerifiedApplyService(new RecorderGit(true));
		const result = await service.apply(root, {
			skill,
			canonicalContent: NEW_CANONICAL,
			canonicalRevision: "new-rev",
			review,
			targets: [codexTarget, claudeTarget, piTarget],
		});

		// success shape
		assert.equal(result.committed, true);
		assert.equal(result.pushed, true);

		// AC1: deployments + verification per affected agent
		assert.equal(readTarget(codexTarget), adaptSkill(NEW_CANONICAL, "codex").content);
		assert.equal(readTarget(claudeTarget), NEW_CANONICAL);
		// pi was blocked -> no deployment
		assert.equal(existsSync(join(piTarget.path, "review", "SKILL.md")), false);

		// AC2: canonical + variant + analysis + provenance committed together
		assert.equal(
			result.stagedCanonical,
			"skills/misc/review/SKILL.md",
		);
		assert.deepEqual(result.stagedVariants, [
			".skillmgr/variants/review/codex/SKILL.md",
		]);
		assert.equal(
			result.stagedAnalysis,
			".skillmgr/adaptation-reviews/review/new-rev.json",
		);
		assert.equal(result.manifestUpdated, true);

		// provenance: pinned revision bumped, variant recorded
		const manifest = parseManifest(
			readFileSync(join(root, "skillmgr.yaml"), "utf-8"),
		);
		assert.equal(manifest.skills[skill].identity?.pinnedRevision, "new-rev");
		const variants = manifest.skills[skill].variants ?? [];
		assert.deepEqual(variants.map((v) => v.agent), ["codex"]);
		assert.equal(variants[0].baseRevision, "new-rev");
		assert.equal(variants[0].deployedTo, "t-codex/review");

		// analysis artifact written
		assert.equal(
			existsSync(join(root, result.stagedAnalysis)),
			true,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("AC1: git transaction order is stage-aware add -> commit -> push", async () => {
	const { root, skill } = initApplyRepo();
	try {
		const codexTarget: ApplyTarget = { agent: "codex", path: join(root, "t-codex") };
		const review = makeReview(skill, [proposedAgent("codex", NEW_CANONICAL)]);
		const git = new RecorderGit(true);
		const service = new VerifiedApplyService(git);
		await service.apply(root, {
			skill,
			canonicalContent: NEW_CANONICAL,
			canonicalRevision: "new-rev",
			review,
			targets: [codexTarget],
		});
		assert.deepEqual(git.calls, ["add", "commit", "push"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("AC3: a verification failure restores prior local copies and prevents any commit/push", async () => {
	const { root, skill } = initApplyRepo();
	try {
		const codexTarget: ApplyTarget = { agent: "codex", path: join(root, "t-codex") };
		mkdirSync(join(codexTarget.path, "review"), { recursive: true });
		const priorCopy = "---\nname: review\ndescription: PRIOR deployed copy.\n---\nPrior.\n";
		writeFileSync(join(codexTarget.path, "review", "SKILL.md"), priorCopy);

		// Craft a proposed variant whose content STILL contains a removed field,
		// so the post-deploy verification fails.
		const broken = proposedAgent("codex", NEW_CANONICAL);
		broken.proposed!.content =
			"---\nname: review\ndescription: New canonical.\nuser-invocable: true\nmodel: gpt-5\n---\nNew body.\n";
		broken.proposed!.removed = ["user-invocable"];
		const review = makeReview(skill, [broken]);

		const git = new RecorderGit(true);
		const service = new VerifiedApplyService(git);
		const result = await service.apply(root, {
			skill,
			canonicalContent: NEW_CANONICAL,
			canonicalRevision: "new-rev",
			review,
			targets: [codexTarget],
		});

		// no commit/push happened; rollback reported
		assert.equal(result.committed, false);
		assert.equal(result.restored, true);
		assert.ok(result.error, "reports the failure");
		assert.deepEqual(git.calls, [], "git was never touched");

		// the prior deployed copy is restored byte-for-byte
		assert.equal(readTarget(codexTarget), priorCopy);
		// the repo canonical + variant sidecar were not written (staging rolled back)
		assert.equal(
			readFileSync(join(root, "skills", "misc", "review", "SKILL.md"), "utf-8"),
			OLD_CANONICAL,
		);
		assert.equal(
			existsSync(join(root, ".skillmgr", "variants", "review", "codex", "SKILL.md")),
			false,
		);
		// no analysis artifact leaked
		assert.equal(
			existsSync(join(root, ".skillmgr", "adaptation-reviews", "review", "new-rev.json")),
			false,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("AC3: a deployment failure (no matching target) is skipped, not a hard error, when other agents succeed", async () => {
	const { root, skill } = initApplyRepo();
	try {
		const codexTarget: ApplyTarget = { agent: "codex", path: join(root, "t-codex") };
		// claude is proposed/canonical but has NO target -> skipped safely
		const review = makeReview(skill, [
			proposedAgent("codex", NEW_CANONICAL),
			canonicalAgent("claude"),
		]);
		const git = new RecorderGit(true);
		const service = new VerifiedApplyService(git);
		const result = await service.apply(root, {
			skill,
			canonicalContent: NEW_CANONICAL,
			canonicalRevision: "new-rev",
			review,
			targets: [codexTarget],
		});
		assert.equal(result.committed, true);
		assert.equal(result.pushed, true);
		const claude = result.agents.find((a) => a.agent === "claude");
		assert.equal(claude?.status, "skipped");
		assert.equal(claude?.deployed, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("AC4: a rejected push keeps the verified local commit and writes an Attention item (never a rebase)", async () => {
	const { root, bare, skill } = initGitRepo();
	try {
		const codexTarget: ApplyTarget = { agent: "codex", path: join(root, "t-codex") };
		const claudeTarget: ApplyTarget = { agent: "claude", path: join(root, "t-claude") };
		const review = makeReview(skill, [
			proposedAgent("codex", NEW_CANONICAL),
			canonicalAgent("claude"),
		]);

		const service = new VerifiedApplyService(); // real git
		// break the remote so the push must fail (simulates a rejected push)
		git(root, ["remote", "remove", "origin"]);
		const result = await service.apply(root, {
			skill,
			canonicalContent: NEW_CANONICAL,
			canonicalRevision: "new-rev",
			review,
			targets: [codexTarget, claudeTarget],
		});

		// push rejected but local commit retained
		assert.equal(result.pushed, false);
		assert.equal(result.retryable, true);
		assert.ok(result.commitSha, "has a local commit sha");
		assert.ok(result.attention, "an Attention item is created");
		assert.equal(
			existsSync(join(root, result.attention!.path)),
			true,
		);

		// the verified local commit exists and contains the applied files
		const head = git(root, ["rev-parse", "HEAD"]).trim();
		assert.equal(head, result.commitSha);
		const committedCanonical = git(root, [
			"show",
			`HEAD:skills/misc/review/SKILL.md`,
		]);
		assert.equal(committedCanonical, NEW_CANONICAL);
		assert.equal(
			git(root, ["cat-file", "-e", `HEAD:.skillmgr/variants/review/codex/SKILL.md`])
				.length,
			0,
		);

		// the deployed copies remain applied (not rolled back on push failure)
		assert.equal(readTarget(codexTarget), adaptSkill(NEW_CANONICAL, "codex").content);
		assert.equal(readTarget(claudeTarget), NEW_CANONICAL);

		// the remote is UNCHANGED (no rebase pushed the new commit)
		const remoteMain = git(bare, ["rev-parse", "main"]).trim();
		assert.notEqual(remoteMain, result.commitSha);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("AC2 (integration): a successful transaction commits and pushes the revision to origin main", async () => {
	const { root, bare, skill } = initGitRepo();
	try {
		const codexTarget: ApplyTarget = { agent: "codex", path: join(root, "t-codex") };
		const claudeTarget: ApplyTarget = { agent: "claude", path: join(root, "t-claude") };
		const review = makeReview(skill, [
			proposedAgent("codex", NEW_CANONICAL),
			canonicalAgent("claude"),
		]);
		const service = new VerifiedApplyService(); // real git
		const result = await service.apply(root, {
			skill,
			canonicalContent: NEW_CANONICAL,
			canonicalRevision: "new-rev",
			review,
			targets: [codexTarget, claudeTarget],
		});

		assert.equal(result.pushed, true);
		// the commit landed on the bare remote's main branch
		const remoteMain = git(bare, ["rev-parse", "main"]).trim();
		assert.equal(remoteMain, result.commitSha);
		const remoteCanonical = git(bare, ["show", `main:skills/misc/review/SKILL.md`]);
		assert.equal(remoteCanonical, NEW_CANONICAL);
		const remoteVariant = git(bare, [
			"show",
			`main:.skillmgr/variants/review/codex/SKILL.md`,
		]);
		assert.equal(remoteVariant, adaptSkill(NEW_CANONICAL, "codex").content);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("AC2: provenance is committed even when no manifest previously existed", async () => {
	const { root, skill } = initApplyRepo();
	try {
		// remove the manifest so the apply must create provenance from scratch
		rmSync(join(root, "skillmgr.yaml"));
		const codexTarget: ApplyTarget = { agent: "codex", path: join(root, "t-codex") };
		const review = makeReview(skill, [proposedAgent("codex", NEW_CANONICAL)]);
		const service = new VerifiedApplyService(new RecorderGit(true));
		const result = await service.apply(root, {
			skill,
			canonicalContent: NEW_CANONICAL,
			canonicalRevision: "new-rev",
			review,
			targets: [codexTarget],
		});
		assert.equal(result.committed, true);
		assert.equal(result.manifestUpdated, true);
		const manifest = parseManifest(
			readFileSync(join(root, "skillmgr.yaml"), "utf-8"),
		);
		assert.equal(manifest.skills[skill].provenance, "promoted");
		assert.deepEqual(
			(manifest.skills[skill].variants ?? []).map((v) => v.agent),
			["codex"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("validation: a mismatched review skill is rejected before any mutation", async () => {
	const { root, skill } = initApplyRepo();
	try {
		const review = makeReview("some-other-skill", [
			proposedAgent("codex", NEW_CANONICAL),
		]);
		const service = new VerifiedApplyService(new RecorderGit(true));
		await assert.rejects(
			service.apply(root, {
				skill,
				canonicalContent: NEW_CANONICAL,
				canonicalRevision: "new-rev",
				review,
				targets: [{ agent: "codex", path: join(root, "t-codex") }],
			}),
			ApplyError,
		);
		// nothing mutated
		assert.equal(
			readFileSync(join(root, "skills", "misc", "review", "SKILL.md"), "utf-8"),
			OLD_CANONICAL,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
