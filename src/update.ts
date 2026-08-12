// Upstream update contract. This module deliberately contains no filesystem or
// network implementation: callers provide fetch, staging, swap, and rollback.

export type SecurityReviewState = "clear" | "acknowledgement-required";

export interface UpstreamSource {
	/** Canonical clone URL, not a display name or a guessed raw-content URL. */
	url: string;
	/** Directory containing the skill inside the upstream repository. */
	subpath: string;
	/** Immutable git revision currently represented by the repo mirror. */
	pinnedRevision: string;
}

export interface UpstreamUpdateRequest {
	skillId: string;
	source: UpstreamSource;
	/** Immutable git revision selected after a freshness check. */
	targetRevision: string;
	repoMirrorPath: string;
}

export interface SnapshotFile {
	/** POSIX-style path relative to the skill directory. */
	path: string;
	sha: string;
	bytes: number;
	/** True for a file that must retain executable permissions on deployment. */
	executable: boolean;
	/** In-memory text used only for local security analysis; never persist this field. */
	content?: string;
}

export interface SkillSnapshot {
	revision: string;
	files: SnapshotFile[];
}

export type FileChangeKind = "added" | "removed" | "modified" | "unchanged";

export interface FileChange {
	path: string;
	kind: FileChangeKind;
	before?: SnapshotFile;
	after?: SnapshotFile;
	/** Set by the fetch/diff implementation when content signals executable behavior. */
	behaviorSignals: ExecutableBehaviorSignal[];
}

export type ExecutableBehaviorSignal =
	| "executable-file"
	| "network-call"
	| "credential-reference"
	| "setup-step";

export interface SecurityGate {
	state: SecurityReviewState;
	changes: FileChange[];
	/** Exact phrase required to release a review-required update. */
	requiredAcknowledgement?: string;
}

export interface UpdatePreview {
	request: UpstreamUpdateRequest;
	current: SkillSnapshot;
	incoming: SkillSnapshot;
	changes: FileChange[];
	security: SecurityGate;
}

export interface UpdateAcknowledgement {
	phrase: string;
	acknowledgedAt: string;
}

export interface StagedUpdate {
	request: UpstreamUpdateRequest;
	preview: UpdatePreview;
	stagePath: string;
	backupPath: string;
}

export interface ApplyUpdateResult {
	skillId: string;
	previousRevision: string;
	appliedRevision: string;
	repoMirrorPath: string;
	rollbackPath: string;
}

export interface RollbackUpdateResult {
	skillId: string;
	restoredRevision: string;
	repoMirrorPath: string;
}

/**
 * Boundary for the eventual IO implementation. Apply must stage, verify, then
 * atomically swap the repo mirror. Local-copy propagation is deliberately not
 * part of this contract.
 */
export interface UpstreamUpdateService {
	fetchSnapshot(source: UpstreamSource, revision: string): Promise<SkillSnapshot>;
	preview(request: UpstreamUpdateRequest): Promise<UpdatePreview>;
	stage(preview: UpdatePreview, acknowledgement?: UpdateAcknowledgement): Promise<StagedUpdate>;
	apply(staged: StagedUpdate): Promise<ApplyUpdateResult>;
	rollback(result: ApplyUpdateResult): Promise<RollbackUpdateResult>;
}

function acknowledgementPhrase(request: UpstreamUpdateRequest): string {
	return `UPDATE ${request.skillId} TO ${request.targetRevision}`;
}

/**
 * A security review is required when executable behavior is added or changed.
 * Removed behavior is visible in the diff but does not require an acknowledgement.
 */
export function securityGateFor(
	request: UpstreamUpdateRequest,
	changes: FileChange[],
): SecurityGate {
	const reviewChanges = changes.filter(
		(change) =>
			change.kind !== "removed" && change.behaviorSignals.length > 0,
	);

	if (reviewChanges.length === 0) {
		return { state: "clear", changes: [] };
	}

	return {
		state: "acknowledgement-required",
		changes: reviewChanges,
		requiredAcknowledgement: acknowledgementPhrase(request),
	};
}

/** Returns true only when a required acknowledgement exactly matches its phrase. */
export function hasRequiredAcknowledgement(
	gate: SecurityGate,
	acknowledgement?: UpdateAcknowledgement,
): boolean {
	return (
		gate.state === "clear" ||
		(gate.requiredAcknowledgement !== undefined &&
			acknowledgement?.phrase === gate.requiredAcknowledgement)
	);
}
