import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	cpSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
	hasRequiredAcknowledgement,
	securityGateFor,
	type ApplyUpdateResult,
	type ExecutableBehaviorSignal,
	type FileChange,
	type RollbackUpdateResult,
	type SecurityGate,
	type SkillSnapshot,
	type SnapshotFile,
	type StagedUpdate,
	type UpdateAcknowledgement,
	type UpdatePreview,
	type UpstreamSource,
	type UpstreamUpdateRequest,
	type UpstreamUpdateService,
} from "./update.ts";

const execFile = promisify(execFileCallback);
const TEXT_LIMIT = 512 * 1024;
const NETWORK = /\b(?:curl|wget|fetch)\b|https?:\/\//i;
const CREDENTIAL = /\b(?:api[_-]?key|access[_-]?token|secret|password|credential)\b/i;
const SETUP = /\b(?:npm|pnpm|yarn|pip(?:x)?|brew|apt(?:-get)?)\s+(?:install|add)\b/i;

export class UpdateError extends Error {}

function sha(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function unixPath(path: string): string {
	return path.split(sep).join("/");
}

function signalContent(content: string, executable: boolean): ExecutableBehaviorSignal[] {
	const signals: ExecutableBehaviorSignal[] = [];
	if (executable) signals.push("executable-file");
	if (NETWORK.test(content)) signals.push("network-call");
	if (CREDENTIAL.test(content)) signals.push("credential-reference");
	if (SETUP.test(content)) signals.push("setup-step");
	return signals;
}

/** Read a complete directory snapshot. Symlinks are rejected for safe deployment. */
export function snapshotDirectory(root: string, revision: string): SkillSnapshot {
	const files: SnapshotFile[] = [];
	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const absolute = join(dir, entry.name);
			if (entry.isSymbolicLink()) throw new UpdateError(`Symlink not allowed in upstream snapshot: ${entry.name}`);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile()) {
				const bytes = readFileSync(absolute);
				const content = bytes.length <= TEXT_LIMIT ? bytes.toString("utf-8") : undefined;
				files.push({
					path: unixPath(relative(root, absolute)),
					sha: sha(bytes),
					bytes: bytes.length,
					executable: (statSync(absolute).mode & 0o111) !== 0,
					content,
				});
			}
		}
	};
	visit(root);
	files.sort((a, b) => a.path.localeCompare(b.path));
	return { revision, files };
}

/** Compare complete skill directories. Signals only count when behavior is added or changed. */
export function computeDiff(previous: SkillSnapshot, next: SkillSnapshot): FileChange[] {
	const before = new Map(previous.files.map((file) => [file.path, file]));
	const after = new Map(next.files.map((file) => [file.path, file]));
	const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
	return paths.map((path) => {
		const oldFile = before.get(path);
		const newFile = after.get(path);
		const kind = !oldFile ? "added" : !newFile ? "removed" : oldFile.sha !== newFile.sha || oldFile.executable !== newFile.executable ? "modified" : "unchanged";
		const changedBehavior = kind === "added" || kind === "modified";
		return {
			path,
			kind,
			before: oldFile,
			after: newFile,
			behaviorSignals: changedBehavior && newFile ? signalContent(newFile.content ?? "", newFile.executable) : [],
		};
	});
}

/** Security gate without UI-specific acknowledgement wording. */
export function assessSecurityGate(changes: FileChange[]): SecurityGate {
	const review = changes.filter((change) => change.kind !== "removed" && change.behaviorSignals.length > 0);
	return review.length ? { state: "acknowledgement-required", changes: review } : { state: "clear", changes: [] };
}

function assertSubpath(root: string, subpath: string): string {
	const skillRoot = resolve(root, subpath);
	if (skillRoot !== resolve(root) && !skillRoot.startsWith(resolve(root) + sep)) throw new UpdateError("Upstream subpath escapes the cloned repository.");
	if (!lstatSync(skillRoot).isDirectory()) throw new UpdateError(`Upstream skill directory not found: ${subpath}`);
	return skillRoot;
}

function revisionFor(root: string): Promise<string> {
	return execFile("git", ["rev-parse", "HEAD"], { cwd: root }).then(({ stdout }) => String(stdout).trim());
}

/**
 * IO implementation for the update contract. Every remote fetch uses a fresh,
 * temporary shallow clone; no checkout is retained between operations.
 */
export class GitUpstreamUpdateService implements UpstreamUpdateService {
	private readonly roots = new WeakMap<SkillSnapshot, string>();
	private readonly temporaryRoots = new Set<string>();

	async fetchSnapshot(source: UpstreamSource, revision: string): Promise<SkillSnapshot> {
		const checkout = mkdtempSync(join(tmpdir(), "skill-manager-upstream-"));
		this.temporaryRoots.add(checkout);
		try {
			// --branch supports immutable tags and named revisions published by upstream.
			// Git does not consistently accept a raw commit SHA as --branch, so retry
			// with a shallow fetch when the manifest pins a SHA directly.
			try {
				await execFile("git", ["clone", "--depth", "1", "--branch", revision, source.url, checkout]);
			} catch {
				rmSync(checkout, { recursive: true, force: true });
				await execFile("git", ["clone", "--depth", "1", source.url, checkout]);
				await execFile("git", ["fetch", "--depth", "1", "origin", revision], { cwd: checkout });
				await execFile("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: checkout });
			}
			const resolvedRevision = await revisionFor(checkout);
			const snapshot = snapshotDirectory(assertSubpath(checkout, source.subpath), resolvedRevision);
			this.roots.set(snapshot, assertSubpath(checkout, source.subpath));
			return snapshot;
		} catch (error) {
			rmSync(checkout, { recursive: true, force: true });
			this.temporaryRoots.delete(checkout);
			throw new UpdateError(`Unable to fetch ${source.url} at ${revision}: ${error instanceof Error ? error.message : "unknown git error"}`);
		}
	}

	async preview(request: UpstreamUpdateRequest): Promise<UpdatePreview> {
		const current = snapshotDirectory(request.repoMirrorPath, request.source.pinnedRevision);
		this.roots.set(current, request.repoMirrorPath);
		const incoming = await this.fetchSnapshot(request.source, request.targetRevision);
		const changes = computeDiff(current, incoming);
		const security = securityGateFor(request, changes);
		return { request, current, incoming, changes, security };
	}

	async stage(preview: UpdatePreview, acknowledgement?: UpdateAcknowledgement): Promise<StagedUpdate> {
		if (!hasRequiredAcknowledgement(preview.security, acknowledgement)) throw new UpdateError("Security acknowledgement is required before staging this update.");
		const source = this.roots.get(preview.incoming);
		if (!source) throw new UpdateError("Incoming snapshot is not available for staging.");
		const target = resolve(preview.request.repoMirrorPath);
		const stagePath = join(dirname(target), `.${basename(target)}.skillmgr-stage-${randomUUID()}`);
		const backupPath = join(dirname(target), `.${basename(target)}.skillmgr-backup-${randomUUID()}`);
		try {
			cpSync(source, stagePath, { recursive: true, force: false, verbatimSymlinks: true });
			const staged = snapshotDirectory(stagePath, preview.incoming.revision);
			if (JSON.stringify(staged.files.map((f) => [f.path, f.sha, f.executable])) !== JSON.stringify(preview.incoming.files.map((f) => [f.path, f.sha, f.executable]))) {
				rmSync(stagePath, { recursive: true, force: true });
				throw new UpdateError("Staged snapshot verification failed.");
			}
			return { request: preview.request, preview, stagePath, backupPath };
		} catch (error) {
			rmSync(stagePath, { recursive: true, force: true });
			throw error;
		}
	}

	async apply(staged: StagedUpdate): Promise<ApplyUpdateResult> {
		const target = resolve(staged.request.repoMirrorPath);
		if (!lstatSync(target).isDirectory()) throw new UpdateError("Repo mirror is missing before apply.");
		try {
			renameSync(target, staged.backupPath);
			renameSync(staged.stagePath, target);
			const applied = snapshotDirectory(target, staged.preview.incoming.revision);
			if (JSON.stringify(applied.files.map((f) => [f.path, f.sha, f.executable])) !== JSON.stringify(staged.preview.incoming.files.map((f) => [f.path, f.sha, f.executable]))) throw new UpdateError("Applied snapshot verification failed.");
			return { skillId: staged.request.skillId, previousRevision: staged.preview.current.revision, appliedRevision: staged.preview.incoming.revision, repoMirrorPath: target, rollbackPath: staged.backupPath };
		} catch (error) {
			if (!lstatSync(target, { throwIfNoEntry: false }) && lstatSync(staged.backupPath, { throwIfNoEntry: false })) renameSync(staged.backupPath, target);
			throw error;
		}
	}

	async rollback(result: ApplyUpdateResult): Promise<RollbackUpdateResult> {
		if (!lstatSync(result.rollbackPath, { throwIfNoEntry: false })) throw new UpdateError("Rollback snapshot is unavailable.");
		rmSync(result.repoMirrorPath, { recursive: true, force: true });
		renameSync(result.rollbackPath, result.repoMirrorPath);
		return { skillId: result.skillId, restoredRevision: result.previousRevision, repoMirrorPath: result.repoMirrorPath };
	}

	dispose(): void {
		for (const root of this.temporaryRoots) rmSync(root, { recursive: true, force: true });
		this.temporaryRoots.clear();
	}
}
