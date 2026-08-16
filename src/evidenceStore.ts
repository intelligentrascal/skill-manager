// Evidence store: on-disk persistence for the active registry and pending
// proposals (the Attention queue). The active registry lives in the agent-skills
// repo (.skillmgr/agent-evidence-registry.json) because an approved revision is
// committed there (AC4); proposals are transient and live alongside under
// .skillmgr/attention/. A missing file falls back to the seed registry so a fresh
// checkout still reports a complete, evidence-backed active registry; an invalid
// on-disk registry throws rather than silently reverting to the seed.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { repoRoot } from "./config.ts";
import {
	defaultRegistry,
	validateRegistry,
	type EvidenceRegistry,
} from "./evidenceRegistry.ts";
import type { RegistryProposal } from "./evidenceCheck.ts";

export interface RegistryPaths {
	activeRegistryPath: string;
	attentionDir: string;
}

/** Registry lives under the agent-skills repo, overridable for tests. */
export function evidenceRegistryRoot(): string {
	return process.env.SM_EVIDENCE_REGISTRY_ROOT || repoRoot();
}

export function registryPaths(root: string): RegistryPaths {
	return {
		activeRegistryPath: join(
			root,
			".skillmgr",
			"agent-evidence-registry.json",
		),
		attentionDir: join(root, ".skillmgr", "attention"),
	};
}

/** Read the active registry; a missing/invalid file falls back to the seed. */
export function readActiveRegistry(path: string): EvidenceRegistry {
	if (existsSync(path)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf-8"));
		} catch (error) {
			throw new RegistryReadError(
				error instanceof Error ? error.message : String(error),
			);
		}
		// A corrupt on-disk registry must not silently revert to the seed.
		validateRegistry(parsed);
		return parsed;
	}
	return defaultRegistry();
}

export class RegistryReadError extends Error {
	constructor(message: string) {
		super(`agent evidence registry on disk is invalid: ${message}`);
		this.name = "RegistryReadError";
	}
}

export function writeActiveRegistry(
	path: string,
	registry: EvidenceRegistry,
): void {
	validateRegistry(registry);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(registry, null, 2) + "\n", "utf-8");
}

/** List pending proposals in the Attention dir (newest first). */
export function listProposals(attentionDir: string): RegistryProposal[] {
	if (!existsSync(attentionDir)) return [];
	const proposals: RegistryProposal[] = [];
	for (const entry of readdirSync(attentionDir)) {
		if (!entry.endsWith(".json")) continue;
		try {
			const parsed: unknown = JSON.parse(
				readFileSync(join(attentionDir, entry), "utf-8"),
			);
			proposals.push(parsed as RegistryProposal);
		} catch {
			// ignore unreadable proposal files - they are not authoritative
		}
	}
	return proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readProposal(
	attentionDir: string,
	id: string,
): RegistryProposal | null {
	const path = join(attentionDir, `${id}.json`);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as RegistryProposal;
	} catch {
		return null;
	}
}

export function writeProposal(
	attentionDir: string,
	proposal: RegistryProposal,
): void {
	mkdirSync(attentionDir, { recursive: true });
	writeFileSync(
		join(attentionDir, `${proposal.id}.json`),
		JSON.stringify(proposal, null, 2) + "\n",
		"utf-8",
	);
}
