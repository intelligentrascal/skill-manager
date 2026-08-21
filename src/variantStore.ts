// Variant store: full-snapshot variants in a manager-owned sidecar dir
// (spec 4: .skillmgr/variants/<skill>/<agent>/), deployed explicitly to a
// chosen agent discovery path. V1 = full snapshots, no patches.
//
// Flow: create (adapt repo/canonical content -> store) -> deploy (copy to the
// agent path) -> verify (compat re-check on the deployed copy). Deployment is
// verified afterward; a failure is reported, not automatically rolled back.

import {
	mkdirSync,
	readFileSync,
	writeFileSync,
	copyFileSync,
	rmSync,
	existsSync,
	readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { adaptSkill, verifyAdaptation, type AdaptResult } from "./variant.ts";
import type { AgentId } from "./compat.ts";
import type { SkillVariant } from "./manifest.ts";

export interface VariantArtifact {
	skill: string;
	agent: AgentId;
	storePath: string;
	deployedTo?: string;
	adapt: AdaptResult;
	verified: boolean;
}

/** Sidecar store root (created on demand). */
export function variantStoreRoot(repoGitRoot: string): string {
	return join(repoGitRoot, ".skillmgr", "variants");
}

/** Create a variant for an agent from the canonical skill content. */
export function createVariant(
	repoGitRoot: string,
	skill: string,
	agent: AgentId,
	canonicalContent: string,
): VariantArtifact {
	const adapt = adaptSkill(canonicalContent, agent);
	if (adapt.blocked) {
		throw new Error(
			`Cannot create a ${agent} variant of ${skill}: ${adapt.blocked}`,
		);
	}
	const storePath = join(variantStoreRoot(repoGitRoot), skill, agent);
	// The variant is registered by writing its registration file into the sidecar
	// store next to the snapshot, so creation is atomic: snapshot and
	// registration are written together and a failed write removes the whole
	// entry. No committed skillmgr.yaml is touched, so a later git reset or
	// checkout cannot drop the registration while the snapshot survives.
	const baseRevision = createHash("sha256").update(canonicalContent).digest("hex");
	try {
		mkdirSync(storePath, { recursive: true });
		writeFileSync(join(storePath, "SKILL.md"), adapt.content, "utf-8");
		writeFileSync(
			join(storePath, "variant.json"),
			JSON.stringify(
				{
					skill,
					agent,
					baseRevision,
					// Empty-path convention: a created-but-not-deployed variant
					// resolves to no file (the matrix reports "Variant stored").
					deployedTo: "",
				},
				null,
				2,
			) + "\n",
			"utf-8",
		);
	} catch (error) {
		rmSync(storePath, { recursive: true, force: true });
		throw error;
	}
	return { skill, agent, storePath, adapt, verified: false };
}

/** Deploy the stored variant to an agent discovery path (explicit target). */
export function deployVariant(storePath: string, targetPath: string): void {
	if (!existsSync(join(storePath, "SKILL.md"))) {
		throw new Error(`No variant at ${storePath}`);
	}
	mkdirSync(targetPath, { recursive: true });
	copyFileSync(join(storePath, "SKILL.md"), join(targetPath, "SKILL.md"));
}

/**
 * Verify a deployed variant: the removed fields must be gone from the copy
 * the target will read (spec 4b). Pure check over the deployed content.
 */
export function verifyDeployedVariant(
	deployedContent: string,
	adapt: AdaptResult,
	target: AgentId,
): { ok: boolean; stillPresent: string[] } {
	const fields = extractFrontmatterKeys(deployedContent);
	return verifyAdaptation(fields, adapt.removed, target);
}

/** Minimal frontmatter key extraction for verification. */
function extractFrontmatterKeys(content: string): string[] {
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

/** Remove a variant (and its deployment file if the target is given). */
export function removeVariant(
	storePath: string,
	deployedTarget?: string,
): void {
	if (deployedTarget && existsSync(join(deployedTarget, "SKILL.md"))) {
		rmSync(join(deployedTarget, "SKILL.md"), { force: true });
	}
	rmSync(storePath, { recursive: true, force: true });
}

/** Read the stored variant's SKILL.md. */
export function readVariant(storePath: string): string | null {
	const p = join(storePath, "SKILL.md");
	return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

/**
 * Read the sidecar-store registrations for one skill. The matrix reads these
 * (merged with the provenance manifest) so variants created in the workspace
 * are reported even though they never touch the committed skillmgr.yaml.
 * Malformed or missing registration files are skipped, never invented.
 */
export function readVariantRegistrations(
	repoGitRoot: string,
	skill: string,
): SkillVariant[] {
	if (!repoGitRoot) return [];
	const root = join(variantStoreRoot(repoGitRoot), skill);
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const registrations: SkillVariant[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const regPath = join(root, entry.name, "variant.json");
		if (!existsSync(regPath)) continue;
		try {
			const raw = JSON.parse(readFileSync(regPath, "utf-8")) as {
				agent?: unknown;
				baseRevision?: unknown;
				deployedTo?: unknown;
			};
			if (
				typeof raw.agent === "string" &&
				typeof raw.baseRevision === "string" &&
				typeof raw.deployedTo === "string"
			) {
				registrations.push({
					agent: raw.agent,
					baseRevision: raw.baseRevision,
					deployedTo: raw.deployedTo,
				});
			}
		} catch {
			// malformed registration - skip, never guess
		}
	}
	return registrations;
}
