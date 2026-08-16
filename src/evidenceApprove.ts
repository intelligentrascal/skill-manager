// Approval gate: promoting a pending proposal to the active registry is the
// ONLY path that changes the active registry (AC3). Proposals and the monthly
// check never write the active registry; only an explicit approve does.
//
// Approval re-baselines changed sources (contentHash + observedAt), bumps the
// registry version, writes the registry, then commits and pushes to
// agent-skills/main with the source evidence (AC4). A failed push leaves the
// verified local commit in place and reports the failure - no automatic rebase
// or rollback (the local commit is retryable with a plain `git push`).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	bumpRegistryVersion,
	validateRegistry,
	type EvidenceRegistry,
} from "./evidenceRegistry.ts";
import type { RegistryProposal } from "./evidenceCheck.ts";
import {
	readActiveRegistry,
	readProposal,
	registryPaths,
	writeActiveRegistry,
	writeProposal,
} from "./evidenceStore.ts";

const execFileAsync = promisify(execFile);

export class ApprovalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApprovalError";
	}
}

export interface ApprovalResult {
	id: string;
	registryVersion: string;
	commitSha: string;
	pushed: boolean;
	pushError?: string;
	rebaselinedSources: number;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd: repoRoot });
		return String(stdout).trim();
	} catch (error) {
		const message =
			error instanceof Error ? error.message : String(error);
		throw new ApprovalError(`git ${args.join(" ")} failed: ${message}`);
	}
}

function shortHash(hash: string): string {
	return hash ? hash.slice(0, 8) : "(none)";
}

/** Re-baseline changed/no-baseline sources into the registry. Returns the count updated. */
function reBaseline(
	registry: EvidenceRegistry,
	proposal: RegistryProposal,
): number {
	let updated = 0;
	for (const check of proposal.checks) {
		if (check.status !== "changed" && check.status !== "no-baseline") continue;
		const profile = registry.profiles[check.agent];
		if (!profile) continue;
		const source = profile.sources.find((s) => s.url === check.url);
		if (!source) continue;
		source.contentHash = check.currentHash;
		source.observedAt = check.fetchedAt;
		updated++;
	}
	return updated;
}

function commitMessage(
	proposal: RegistryProposal,
	newVersion: string,
	rebaselined: { agent: string; url: string; before: string; after: string }[],
): string {
	const lines = [
		`agent-evidence-registry: ${proposal.baseRegistryVersion} -> ${newVersion}`,
		"",
		`Approved proposal ${proposal.id} (${proposal.createdBy}).`,
		"",
		`Sources re-baselined (${rebaselined.length}):`,
	];
	for (const item of rebaselined) {
		lines.push(
			`- ${item.agent} ${item.url}: ${shortHash(item.before)} -> ${shortHash(item.after)}`,
		);
	}
	lines.push("", proposal.summary);
	return lines.join("\n");
}

export async function approveProposal(options: {
	repoRoot: string;
	proposalId: string;
	now?: Date;
}): Promise<ApprovalResult> {
	const now = options.now ?? new Date();
	const paths = registryPaths(options.repoRoot);

	const proposal = readProposal(paths.attentionDir, options.proposalId);
	if (!proposal) {
		throw new ApprovalError(
			`No pending proposal '${options.proposalId}' in Attention.`,
		);
	}
	if (proposal.status !== "pending") {
		throw new ApprovalError(
			`Proposal '${options.proposalId}' is already ${proposal.status}.`,
		);
	}

	const active = readActiveRegistry(paths.activeRegistryPath);
	if (active.registryVersion !== proposal.baseRegistryVersion) {
		throw new ApprovalError(
			`Proposal was built against registry ${proposal.baseRegistryVersion}, but the active registry is ${active.registryVersion}. Re-run the check.`,
		);
	}

	const rebaselined = reBaseline(active, proposal);
	if (rebaselined === 0) {
		throw new ApprovalError(
			"Nothing to approve: the proposal has no changed or new-baseline sources.",
		);
	}

	const newVersion = bumpRegistryVersion(active.registryVersion);
	active.registryVersion = newVersion;
	active.generatedAt = now.toISOString();
	validateRegistry(active);
	writeActiveRegistry(paths.activeRegistryPath, active);

	// Commit with the source evidence; retry with an explicit identity when the
	// repo has none configured.
	const rebaselinedDetail = proposal.checks
		.filter((c) => c.status === "changed" || c.status === "no-baseline")
		.map((c) => ({
			agent: c.agent,
			url: c.url,
			before: c.previousHash,
			after: c.currentHash,
		}));
	const message = commitMessage(proposal, newVersion, rebaselinedDetail);
	const registryRelPath = ".skillmgr/agent-evidence-registry.json";
	await git(options.repoRoot, ["add", registryRelPath]);
	try {
		await git(options.repoRoot, ["commit", "-m", message]);
	} catch {
		await git(options.repoRoot, [
			"-c",
			"user.name=skill-manager",
			"-c",
			"user.email=skill-manager@localhost",
			"commit",
			"-m",
			message,
		]);
	}
	const commitSha = await git(options.repoRoot, ["rev-parse", "HEAD"]);

	let pushed = true;
	let pushError: string | undefined;
	try {
		await git(options.repoRoot, ["push", "origin", "HEAD"]);
	} catch (error) {
		pushed = false;
		pushError =
			error instanceof Error ? error.message : String(error);
	}

	proposal.status = "approved";
	writeProposal(paths.attentionDir, proposal);

	return {
		id: proposal.id,
		registryVersion: newVersion,
		commitSha,
		pushed,
		...(pushError ? { pushError } : {}),
		rebaselinedSources: rebaselined,
	};
}
