import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentId } from "./compat.ts";
import { resolveExplain, type DiscoveryProfile } from "./discovery.ts";
import type { EvidenceRegistry } from "./evidenceRegistry.ts";
import type { SkillRecord as ManifestSkillRecord } from "./manifest.ts";
import { adaptSkill } from "./variant.ts";
import { variantStoreRoot, verifyDeployedVariant } from "./variantStore.ts";

export type VariantMatrixStatus =
	| "Canonical"
	| "Variant stored"
	| "Deployed"
	| "Verified"
	| "Unknown";

export interface VariantMatrixCopy {
	location: string;
	path: string;
	sha: string;
}

export interface VariantDifferenceLine {
	kind: "context" | "added" | "removed" | "ellipsis";
	text: string;
}

export interface VariantDifference {
	summary: string;
	lines: VariantDifferenceLine[];
}

export interface VariantRevision {
	canonical: string;
	agentProfile: string;
}

export interface VariantEvidence {
	level: "documented" | "inferred" | "unknown";
	observedVersion: string;
	observedAt: string;
	basis: string[];
}

export interface AgentVariantRow {
	agent: AgentId;
	label: string;
	status: VariantMatrixStatus;
	summary: string;
	difference: VariantDifference | null;
	revision: VariantRevision | null;
	evidence: VariantEvidence | null;
}

export interface AgentVariantMatrix {
	skill: string;
	generatedAt: string;
	agents: AgentVariantRow[];
}

export interface BuildAgentVariantMatrixInput {
	skill: string;
	copies: VariantMatrixCopy[];
	repoGitRoot: string;
	manifestRecord?: ManifestSkillRecord;
	registry?: EvidenceRegistry;
	profiles?: Partial<Record<AgentId, DiscoveryProfile>>;
	home: string;
	now?: Date;
}

const AGENTS: Array<{ agent: AgentId; label: string }> = [
	{ agent: "pi", label: "Pi" },
	{ agent: "claude", label: "Claude" },
	{ agent: "opencode", label: "OpenCode" },
	{ agent: "codex", label: "Codex" },
];

type RawDifferenceLine = {
	kind: "context" | "added" | "removed";
	text: string;
};

function readableDifference(
	canonicalContent: string,
	variantContent: string,
): VariantDifference {
	const canonical = canonicalContent.replaceAll("\r\n", "\n").split("\n");
	const variant = variantContent.replaceAll("\r\n", "\n").split("\n");
	const rows = canonical.length;
	const columns = variant.length;
	const lcs = Array.from({ length: rows + 1 }, () =>
		new Uint32Array(columns + 1),
	);
	for (let left = rows - 1; left >= 0; left -= 1) {
		for (let right = columns - 1; right >= 0; right -= 1) {
			lcs[left][right] =
				canonical[left] === variant[right]
					? lcs[left + 1][right + 1] + 1
					: Math.max(lcs[left + 1][right], lcs[left][right + 1]);
		}
	}

	const raw: RawDifferenceLine[] = [];
	let left = 0;
	let right = 0;
	while (left < rows && right < columns) {
		if (canonical[left] === variant[right]) {
			raw.push({ kind: "context", text: canonical[left] });
			left += 1;
			right += 1;
		} else if (lcs[left + 1][right] >= lcs[left][right + 1]) {
			raw.push({ kind: "removed", text: canonical[left] });
			left += 1;
		} else {
			raw.push({ kind: "added", text: variant[right] });
			right += 1;
		}
	}
	while (left < rows) raw.push({ kind: "removed", text: canonical[left++] });
	while (right < columns) raw.push({ kind: "added", text: variant[right++] });

	const changed = raw
		.map((line, index) => (line.kind === "context" ? -1 : index))
		.filter((index) => index >= 0);
	const visible = new Set<number>();
	for (const index of changed) {
		const first = Math.max(0, index - 2);
		const last = Math.min(raw.length - 1, index + 2);
		for (let context = first; context <= last; context += 1) {
			visible.add(context);
		}
	}
	const lines: VariantDifferenceLine[] = [];
	let previous = -1;
	for (const index of [...visible].sort((a, b) => a - b)) {
		if (previous >= 0 && index > previous + 1) {
			lines.push({
				kind: "ellipsis",
				text: `${index - previous - 1} unchanged lines`,
			});
		}
		lines.push(raw[index]);
		previous = index;
	}
	const added = raw.filter((line) => line.kind === "added").length;
	const removed = raw.filter((line) => line.kind === "removed").length;
	return {
		summary:
			added === 0 && removed === 0
				? "No content difference from canonical"
				: `${added} ${added === 1 ? "line" : "lines"} added · ${removed} ${removed === 1 ? "line" : "lines"} removed`,
		lines,
	};
}

function storedVariantPath(
	repoGitRoot: string,
	skill: string,
	agent: AgentId,
): string | null {
	if (!repoGitRoot) return null;
	const root = resolve(variantStoreRoot(repoGitRoot));
	const candidate = resolve(join(root, skill, agent, "SKILL.md"));
	const fromRoot = relative(root, candidate);
	if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) return null;
	return candidate;
}

function deployedSkillPath(
	deployedTo: string,
	home: string,
	repoGitRoot: string,
): string {
	const expanded = deployedTo.replace(/^~(?=$|[\\/])/, home);
	const target = isAbsolute(expanded)
		? resolve(expanded)
		: resolve(repoGitRoot, expanded);
	return basename(target).toLowerCase() === "skill.md"
		? target
		: join(target, "SKILL.md");
}

function evidenceFor(
	registry: EvidenceRegistry | undefined,
	agent: AgentId,
): VariantEvidence {
	const profile = registry?.profiles[agent];
	return profile
		? {
				level: profile.evidence,
				observedVersion: profile.observedVersion,
				observedAt: profile.observedAt,
				basis: profile.constraints.map((constraint) => constraint.rule),
			}
		: {
				level: "unknown",
				observedVersion: "unknown",
				observedAt: "unknown",
				basis: [],
			};
}

function revisionFor(
	registry: EvidenceRegistry | undefined,
	canonical: string,
): VariantRevision {
	return {
		canonical,
		agentProfile: registry?.registryVersion ?? "unknown",
	};
}

export function buildAgentVariantMatrix(
	input: BuildAgentVariantMatrixInput,
): AgentVariantMatrix {
	const canonical = input.copies.find((copy) => copy.location === "repo");
	return {
		skill: input.skill,
		generatedAt: (input.now ?? new Date()).toISOString(),
		agents: AGENTS.map(({ agent, label }) => {
			const registered = input.manifestRecord?.variants?.find(
				(variant) => variant.agent === agent,
			);
			if (canonical && registered) {
				const snapshotPath = storedVariantPath(
					input.repoGitRoot,
					input.skill,
					agent,
				);
				if (snapshotPath && existsSync(snapshotPath)) {
					try {
						const canonicalContent = readFileSync(canonical.path, "utf-8");
						const variantContent = readFileSync(snapshotPath, "utf-8");
						const profile = input.registry?.profiles[agent];
						const difference = readableDifference(
							canonicalContent,
							variantContent,
						);
						const deploymentPath = deployedSkillPath(
							registered.deployedTo,
							input.home,
							input.repoGitRoot,
						);
						const deployed =
							existsSync(deploymentPath) &&
							readFileSync(deploymentPath, "utf-8") === variantContent;
						const discovery = resolveExplain(
							agent,
							input.profiles?.[agent],
							input.copies,
							input.home,
						);
						const expectedAdaptation = adaptSkill(canonicalContent, agent);
						const adaptationCheck = expectedAdaptation.blocked
							? { ok: false }
							: verifyDeployedVariant(
									variantContent,
									expectedAdaptation,
									agent,
								);
						const variantSha = createHash("sha256")
							.update(variantContent)
							.digest("hex");
						const currentBase =
							!input.manifestRecord?.identity ||
							input.manifestRecord.identity.pinnedRevision ===
								registered.baseRevision;
						const verified =
							deployed &&
							profile !== undefined &&
							profile.evidence !== "unknown" &&
							adaptationCheck.ok &&
							currentBase &&
							discovery.winner?.sha === variantSha &&
							resolve(discovery.winner.path) === resolve(deploymentPath);
						const status = verified
							? ("Verified" as const)
							: deployed
								? ("Deployed" as const)
								: ("Variant stored" as const);
						return {
							agent,
							label,
							status,
							summary: verified
								? `The stored snapshot was re-verified against current adaptation constraints and is the runtime discovery winner. ${difference.summary}.`
								: deployed
									? `The registered deployment is observed and matches the stored snapshot. ${difference.summary}.`
									: `A registered full snapshot is stored. ${difference.summary}.`,
							difference,
							revision: revisionFor(input.registry, registered.baseRevision),
							evidence: evidenceFor(input.registry, agent),
						};
					} catch {
						// A registered artifact that cannot be read remains unknown.
					}
				}
			}
			if (registered) {
				return {
					agent,
					label,
					status: "Unknown" as const,
					summary:
						"A variant is registered, but its stored snapshot is unavailable; its deployment and difference remain unknown.",
					difference: null,
					revision: revisionFor(input.registry, registered.baseRevision),
					evidence: evidenceFor(input.registry, agent),
				};
			}
			if (canonical) {
				const discovery = resolveExplain(
					agent,
					input.profiles?.[agent],
					input.copies,
					input.home,
				);
				if (discovery.winner?.sha === canonical.sha) {
					return {
						agent,
						label,
						status: "Canonical" as const,
						summary: "The runtime discovery winner matches the canonical repository content.",
						difference: null,
						revision: null,
						evidence: null,
					};
				}
			}
			return {
				agent,
				label,
				status: "Unknown" as const,
				summary: "No canonical deployment or registered variant is evidenced.",
				difference: null,
				revision: null,
				evidence: null,
			};
		}),
	};
}
