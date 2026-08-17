// Verified apply transaction (ticket #7).
//
// One approved Adaptation Review safely updates the canonical skill and its
// AI-generated variants as a single managed revision:
//
//   1. STAGE    - write the new canonical SKILL.md and each affected variant
//                snapshot into the agent-skills working tree (not yet committed).
//   2. DEPLOY   - copy the staged revision to each target agent's discovery path.
//   3. VERIFY   - re-read every deployed copy and confirm the removed fields are
//                gone and the bytes match what was staged.
//   4. COMMIT   - git-add the canonical, variants, analysis, and provenance, then
//                commit them together.
//   5. PUSH     - push the commit directly to agent-skills/main.
//
// Safety model (the provenance/adaptation design contract):
// - A deployment or verification failure restores the prior local copies (both
//   the deployed targets and the staged repo working tree) and prevents any
//   partial commit or push.
// - A rejected push never triggers a rebase. The verified local commit is kept
//   on the branch and an Attention item is written for safe review/retry.
//
// The git layer is injectable so the transaction order, rollback, and
// push-rejection recovery are directly unit-testable without a network or a
// real remote.

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	walkForSkills,
} from "./scanner.ts";
import { verifyAdaptation } from "./variant.ts";
import {
	parseManifest,
	upsertSkillEntry,
	newManifestWithEntry,
	type SkillManagerManifest,
	type SkillRecord,
	type SkillVariant,
} from "./manifest.ts";
import type { AdaptationReview } from "./adaptationReview.ts";
import type { AgentId } from "./compat.ts";

const execFileAsync = promisify(execFile);

export class ApplyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApplyError";
	}
}

/** One agent deployment target: the discovery root where SKILL.md is written. */
export interface ApplyTarget {
	agent: AgentId;
	/** Discovery directory (parent of the skill folder). */
	path: string;
}

export interface ApplyRequest {
	skill: string;
	/** The new canonical SKILL.md content (the approved upstream revision). */
	canonicalContent: string;
	/** Revision to record in provenance (e.g. the upstream/source revision). */
	canonicalRevision: string;
	/** The approved Adaptation Review (drives per-agent deployment + variants). */
	review: AdaptationReview;
	/** Deployment targets per agent. Only affected agents with a matching target are deployed. */
	targets?: ApplyTarget[];
	/** Override the repo category for a brand-new skill. */
	category?: string;
}

export interface ApplyAgentResult {
	agent: AgentId;
	status: "deployed" | "verified" | "skipped" | "failed";
	/** A variant sidecar file was staged for this agent. */
	variant: boolean;
	/** The revision was copied to a discovery target. */
	deployed: boolean;
	verified: boolean;
	/** Repo-relative sidecar path, when a variant was staged. */
	stagePath?: string;
	error?: string;
}

export interface AttentionItem {
	id: string;
	/** Repo-relative path of the Attention item. */
	path: string;
}

export interface ApplyResult {
	skill: string;
	committed: boolean;
	commitSha?: string;
	pushed: boolean;
	pushError?: string;
	/** True when a failed push left the local commit for retry. */
	retryable: boolean;
	/** Repo-relative canonical path. */
	stagedCanonical: string;
	/** Repo-relative analysis path. */
	stagedAnalysis: string;
	/** Repo-relative variant sidecar paths. */
	stagedVariants: string[];
	manifestUpdated: boolean;
	agents: ApplyAgentResult[];
	/** Present when a push was rejected; the local commit is retained. */
	attention?: AttentionItem;
	/** True when a failure triggered a full rollback of local copies. */
	restored: boolean;
	/** Present on a deployment/verification failure (no commit/push occurred). */
	error?: string;
}

/** Injectable git boundary so the transaction can be tested without a remote. */
export interface ApplyGit {
	add(repoRoot: string, files: string[]): Promise<void>;
	commit(repoRoot: string, message: string): Promise<string>;
	push(repoRoot: string): Promise<{ pushed: boolean; error?: string }>;
}

class RealGit implements ApplyGit {
	async add(repoRoot: string, files: string[]): Promise<void> {
		await execFileAsync("git", ["-C", repoRoot, "add", "--", ...files]);
	}

	async commit(repoRoot: string, message: string): Promise<string> {
		try {
			await execFileAsync("git", ["-C", repoRoot, "commit", "-m", message]);
		} catch {
			await execFileAsync("git", [
				"-C",
				repoRoot,
				"-c",
				"user.name=skill-manager",
				"-c",
				"user.email=skill-manager@localhost",
				"commit",
				"-m",
				message,
			]);
		}
		const { stdout } = await execFileAsync("git", [
			"-C",
			repoRoot,
			"rev-parse",
			"HEAD",
		]);
		return String(stdout).trim();
	}

	async push(
		repoRoot: string,
	): Promise<{ pushed: boolean; error?: string }> {
		try {
			await execFileAsync("git", [
				"-C",
				repoRoot,
				"push",
				"origin",
				"HEAD:refs/heads/main",
			]);
			return { pushed: true };
		} catch (error) {
			return {
				pushed: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

/** Records writes so any prior local copy can be restored on rollback. */
class WriteTracker {
	private readonly records: {
		path: string;
		existed: boolean;
		prior: string | null;
	}[] = [];

	backup(path: string): void {
		if (this.records.some((r) => r.path === path)) return;
		const existed = existsSync(path);
		const prior = existed ? readFileSync(path, "utf-8") : null;
		this.records.push({ path, existed, prior });
	}

	write(path: string, content: string): void {
		this.backup(path);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf-8");
	}

	restore(path: string): void {
		const rec = this.records.find((r) => r.path === path);
		if (!rec) return;
		this.applyRestore(rec);
	}

	private applyRestore(rec: {
		path: string;
		existed: boolean;
		prior: string | null;
	}): void {
		if (rec.existed) {
			mkdirSync(dirname(rec.path), { recursive: true });
			writeFileSync(rec.path, rec.prior as string, "utf-8");
		} else {
			rmSync(rec.path, { recursive: true, force: true });
		}
	}

	restoreAll(): void {
		for (let i = this.records.length - 1; i >= 0; i--) {
			this.applyRestore(this.records[i]);
		}
	}
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Extract frontmatter keys from SKILL.md content (for verification). */
function frontmatterKeys(content: string): string[] {
	if (!content.startsWith("---")) return [];
	const end = content.indexOf("\n---");
	if (end === -1) return [];
	const block = content.slice(4, end);
	const keys: string[] = [];
	for (const line of block.split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(key)) keys.push(key);
	}
	return keys;
}

function resolveCategory(
	repoRoot: string,
	skill: string,
	override?: string,
): string {
	if (
		override &&
		override.trim() &&
		!/[/\\]/.test(override) &&
		override !== "." &&
		override !== ".."
	) {
		return override.trim();
	}
	const files = walkForSkills(join(repoRoot, "skills"), true);
	const found = files.find((f) => f.name === skill);
	if (found) {
		const rel = relative(join(repoRoot, "skills"), dirname(dirname(found.path)));
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	}
	return "misc";
}

function readManifestSafe(
	path: string,
): { manifestText: string | null; manifest: SkillManagerManifest | null } {
	if (!existsSync(path)) return { manifestText: null, manifest: null };
	try {
		const text = readFileSync(path, "utf-8");
		return { manifestText: text, manifest: parseManifest(text) };
	} catch (error) {
		throw new ApplyError(
			`Provenance manifest is invalid and cannot be updated: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function defaultRecordForApply(): SkillRecord {
	return { provenance: "promoted" };
}

/**
 * The verified apply transaction. Pure with respect to the injectable `git`
 * boundary; all working-tree writes go through temporary trackers so a failure
 * restores the prior local state exactly.
 */
export class VerifiedApplyService {
	private readonly git: ApplyGit;

	constructor(git?: ApplyGit) {
		this.git = git ?? new RealGit();
	}

	async apply(
		repoRoot: string,
		request: ApplyRequest,
		options: { now?: Date } = {},
	): Promise<ApplyResult> {
		const now = options.now ?? new Date();
		const { skill, canonicalContent, canonicalRevision, review } = request;

		if (!skill || !skill.trim()) {
			throw new ApplyError("skill name is required");
		}
		if (typeof canonicalContent !== "string" || !canonicalContent) {
			throw new ApplyError("canonicalContent is required");
		}
		if (!review || !Array.isArray(review.agents)) {
			throw new ApplyError("a generated Adaptation Review is required");
		}
		if (review.skill && review.skill !== skill) {
			throw new ApplyError(
				`the review is for '${review.skill}', not '${skill}'`,
			);
		}

		const category = resolveCategory(repoRoot, skill, request.category);
		const canonicalPath = join(
			repoRoot,
			"skills",
			category,
			skill,
			"SKILL.md",
		);
		const canonicalRel = relative(repoRoot, canonicalPath).replace(/\\/g, "/");

		const staging = new WriteTracker();
		const deploys = new WriteTracker();

		const agents: ApplyAgentResult[] = [];
		const stagedVariantRels: string[] = [];

		try {
			// STAGE 1: canonical content + each affected variant sidecar file.
			staging.write(canonicalPath, canonicalContent);

			for (const agent of review.agents) {
				const agentName = agent.agent;
				const isProposed =
					agent.status === "proposed" &&
					agent.proposed != null &&
					typeof agent.proposed.content === "string";
				const isCanonical = agent.status === "canonical";
				const blocked = agent.status === "blocked";

				if (blocked || (!isProposed && !isCanonical)) {
					agents.push({
						agent: agentName,
						status: "skipped",
						variant: false,
						deployed: false,
						verified: false,
					});
					continue;
				}

				let deployContent: string;
				let variantStaged = false;
				if (isProposed) {
					const storePath = join(
						repoRoot,
						".skillmgr",
						"variants",
						skill,
						agentName,
						"SKILL.md",
					);
					staging.write(storePath, agent.proposed!.content);
					stagedVariantRels.push(
						relative(repoRoot, storePath).replace(/\\/g, "/"),
					);
					deployContent = agent.proposed!.content;
					variantStaged = true;
				} else {
					deployContent = canonicalContent;
				}

				// DEPLOY 2 + VERIFY 3 for this agent.
				const target = (request.targets ?? []).find(
					(t) => t.agent === agentName,
				);
				if (!target) {
					agents.push({
						agent: agentName,
						status: "skipped",
						variant: variantStaged,
						deployed: false,
						verified: false,
						...(variantStaged
							? {
									stagePath: relative(
										repoRoot,
										join(repoRoot, ".skillmgr", "variants", skill, agentName),
									).replace(/\\/g, "/"),
								}
							: {}),
					});
					continue;
				}

				const targetPath = join(target.path, skill, "SKILL.md");
				const removed = isProposed ? (agent.proposed!.removed ?? []) : [];
				try {
					deploys.backup(targetPath);
					deploys.write(targetPath, deployContent);
					const deployed = readFileSync(targetPath, "utf-8");
					if (deployed !== deployContent) {
						throw new ApplyError(
							"deployed copy does not match the staged revision",
						);
					}
					if (isProposed && removed.length) {
						const check = verifyAdaptation(
							frontmatterKeys(deployed),
							removed,
							agentName,
						);
						if (!check.ok) {
							throw new ApplyError(
								`removed fields still present after deploy: ${check.stillPresent.join(", ")}`,
							);
						}
					}
					agents.push({
						agent: agentName,
						status: "verified",
						variant: variantStaged,
						deployed: true,
						verified: true,
					});
				} catch (error) {
					deploys.restore(targetPath);
					const message =
						error instanceof Error ? error.message : String(error);
					// Roll back everything and return without committing/pushing.
					deploys.restoreAll();
					staging.restoreAll();
					return {
						skill,
						committed: false,
						pushed: false,
						retryable: false,
						stagedCanonical: canonicalRel,
						stagedAnalysis: "",
						stagedVariants: [],
						manifestUpdated: false,
						agents: [
							...agents,
							{
								agent: agentName,
								status: "failed",
								variant: variantStaged,
								deployed: false,
								verified: false,
								error: message,
							},
						],
						restored: true,
						error: `Deployment or verification failed for ${agentName}: ${message}`,
					};
				}
			}

			// STAGE provenance (manifest) update - always, so an applied
			// revision records its provenance even for a brand-new managed skill.
			const manifestStaged = true;
			const manifestPath = join(repoRoot, "skillmgr.yaml");
			const { manifestText, manifest } = readManifestSafe(manifestPath);
			{
				const existing = manifest?.skills[skill] ?? defaultRecordForApply();
				const updated: SkillRecord = {
					...existing,
					provenance: existing.provenance ?? "promoted",
				};
				if (updated.identity) {
					updated.identity = {
						...updated.identity,
						pinnedRevision: canonicalRevision,
					};
				}
				const variants: SkillVariant[] = [];
				for (const a of agents) {
					if (a.deployed && a.variant) {
						const t = (request.targets ?? []).find(
							(x) => x.agent === a.agent,
						);
						variants.push({
							agent: a.agent,
							baseRevision: canonicalRevision,
							deployedTo: t
								? relative(repoRoot, join(t.path, skill)).replace(/\\/g, "/")
								: "",
						});
					}
				}
				updated.variants = variants;
				const nextText =
					manifestText === null
						? newManifestWithEntry(skill, updated)
						: upsertSkillEntry(manifestText, skill, updated);
				staging.write(manifestPath, nextText);
			}

			// STAGE the analysis artifact.
			const analysisPath = join(
				repoRoot,
				".skillmgr",
				"adaptation-reviews",
				skill,
				`${canonicalRevision}.json`,
			);
			staging.write(analysisPath, JSON.stringify(review, null, 2) + "\n");
			const analysisRel = relative(repoRoot, analysisPath).replace(/\\/g, "/");

			// COMMIT 4 + PUSH 5.
			const commitFiles = [
				canonicalRel,
				...stagedVariantRels,
				analysisRel,
				...(manifestStaged ? ["skillmgr.yaml"] : []),
			];
			await this.git.add(repoRoot, commitFiles);
			const commitSha = await this.git.commit(
				repoRoot,
				this.commitMessage(skill, canonicalRevision, now),
			);
			const push = await this.git.push(repoRoot);

			if (push.pushed) {
				return {
					skill,
					committed: true,
					commitSha,
					pushed: true,
					retryable: false,
					stagedCanonical: canonicalRel,
					stagedAnalysis: analysisRel,
					stagedVariants: stagedVariantRels,
					manifestUpdated: manifestStaged,
					agents,
					restored: false,
				};
			}

			// Push rejected: keep the verified local commit, create an Attention
			// item, and never rebase (the commit remains retryable).
			const attention = this.writeAttention(
				repoRoot,
				skill,
				commitSha,
				push.error,
				now,
			);
			return {
				skill,
				committed: true,
				commitSha,
				pushed: false,
				pushError: push.error,
				retryable: true,
				stagedCanonical: canonicalRel,
				stagedAnalysis: analysisRel,
				stagedVariants: stagedVariantRels,
				manifestUpdated: manifestStaged,
				agents,
				attention,
				restored: false,
			};
		} catch (error) {
			// Any unexpected failure before a confirmed push: restore all local
			// copies and prevent a partial commit/push.
			deploys.restoreAll();
			staging.restoreAll();
			if (error instanceof ApplyError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new ApplyError(
				`Apply transaction aborted and local copies restored: ${message}`,
			);
		}
	}

	private commitMessage(
		skill: string,
		canonicalRevision: string,
		now: Date,
	): string {
		return [
			`skillmgr: apply verified revision for ${skill} @ ${canonicalRevision}`,
			"",
			`Apply Adaptation Review for ${skill}. Canonical skill, generated variants, analysis, and provenance are committed together as one managed revision (${now.toISOString()}).`,
		].join("\n");
	}

	private writeAttention(
		repoRoot: string,
		skill: string,
		commitSha: string,
		pushError: string | undefined,
		now: Date,
	): AttentionItem {
		const id = `apply-${now.getTime()}-${sha256(skill + commitSha).slice(0, 12)}`;
		const dir = join(repoRoot, ".skillmgr", "attention", "apply");
		mkdirSync(dir, { recursive: true });
		const item = {
			kind: "apply-push-failure",
			id,
			skill,
			commitSha,
			pushError: pushError ?? null,
			createdAt: now.toISOString(),
			note: "The verified local commit is retained. Review and retry the push with `git -C <repo> push origin HEAD:refs/heads/main`; do not rebase or amend.",
		};
		const path = join(dir, `${id}.json`);
		writeFileSync(path, JSON.stringify(item, null, 2) + "\n", "utf-8");
		return { id, path: relative(repoRoot, path).replace(/\\/g, "/") };
	}
}
