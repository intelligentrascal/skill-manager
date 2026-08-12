import { copyFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";

export interface SyncCopy {
	location: string;
	path: string;
	sha: string;
	mtimeISO: string;
	repoClean?: boolean;
}

export interface SyncInventory {
	byName: Record<string, SyncCopy[]>;
}

export interface SyncPreviewCopy {
	location: string;
	path: string;
	sha: string;
	mtimeISO: string;
	text: string;
}

export interface SyncPreview {
	name: string;
	source: SyncPreviewCopy;
	targets: SyncPreviewCopy[];
}

export interface SyncTargetRequest {
	path: string;
	sha: string;
}

export interface SyncResult {
	name: string;
	source: { location: string; sha: string };
	synced: Array<{ location: string; path: string }>;
}

export class SyncError extends Error {}

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function getSyncableCopies(
	inventory: SyncInventory,
	name: string,
): {
	source: SyncCopy;
	targets: SyncCopy[];
} {
	const copies = inventory.byName[name];
	if (!copies?.length) throw new SyncError(`Skill '${name}' not found.`);

	const source = copies.find((copy) => copy.location === "repo");
	if (!source) {
		throw new SyncError(`Skill '${name}' has no repo copy to use as a source.`);
	}

	const targets = copies.filter(
		(copy) => copy.location !== "repo" && copy.sha !== source.sha,
	);
	if (!targets.length) {
		throw new SyncError(
			`Skill '${name}' has no drifted non-repo copies to sync.`,
		);
	}

	return { source, targets };
}

function readPreviewCopy(copy: SyncCopy): SyncPreviewCopy {
	let text: string;
	try {
		text = readFileSync(copy.path, "utf-8");
	} catch {
		throw new SyncError(`Unable to read ${copy.location} copy for preview.`);
	}
	return { ...copy, text };
}

export function previewSyncFromRepo(
	inventory: SyncInventory,
	name: string,
): SyncPreview {
	const { source, targets } = getSyncableCopies(inventory, name);
	return {
		name,
		source: readPreviewCopy(source),
		targets: targets.map(readPreviewCopy),
	};
}

export function syncFromRepo(
	inventory: SyncInventory,
	name: string,
	requestedTargets: SyncTargetRequest[],
): SyncResult {
	const { source, targets } = getSyncableCopies(inventory, name);
	if (!requestedTargets.length) {
		throw new SyncError("Choose at least one target copy to sync.");
	}

	const targetByPath = new Map(targets.map((target) => [target.path, target]));
	const selected = requestedTargets.map((request) => {
		const target = targetByPath.get(request.path);
		if (!target || target.sha !== request.sha) {
			throw new SyncError(
				"The selected targets changed. Preview the sync again.",
			);
		}
		return target;
	});

	if (new Set(selected.map((target) => target.path)).size !== selected.length) {
		throw new SyncError("A target may only be selected once.");
	}

	let sourceText: string;
	try {
		sourceText = readFileSync(source.path, "utf-8");
	} catch {
		throw new SyncError("Unable to read the repo source copy.");
	}
	if (sha(sourceText) !== source.sha || basename(source.path) !== "SKILL.md") {
		throw new SyncError("The repo source changed. Preview the sync again.");
	}

	for (const target of selected) {
		let currentText: string;
		try {
			currentText = readFileSync(target.path, "utf-8");
		} catch {
			throw new SyncError(`Unable to read ${target.location} target copy.`);
		}
		if (
			sha(currentText) !== target.sha ||
			basename(target.path) !== "SKILL.md"
		) {
			throw new SyncError("A target changed. Preview the sync again.");
		}
	}

	try {
		for (const target of selected) copyFileSync(source.path, target.path);
	} catch {
		throw new SyncError(
			"Sync failed before every selected target could be updated.",
		);
	}

	return {
		name,
		source: { location: source.location, sha: source.sha },
		synced: selected.map((target) => ({
			location: target.location,
			path: target.path,
		})),
	};
}
