import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepoManifest, scanAll } from "./scanner.ts";
import { checkUpstream } from "./upstream.ts";
import { compatReport, AGENT_IDS, type AgentId } from "./compat.ts";
import {
	createVariant,
	deployVariant,
	variantStoreRoot,
	verifyDeployedVariant,
} from "./variantStore.ts";
import { adaptSkill } from "./variant.ts";
import { repoRoot } from "./config.ts";
import { readManifestSync } from "./manifest.ts";
import { GitUpstreamUpdateService } from "./updates.ts";
import { resolveExplain } from "./discovery.ts";
import { DISCOVERY_PROFILES } from "./discoveryProfiles.ts";
import { buildHealthActions } from "./health.ts";
import { renderSnapshot } from "./snapshot.ts";
import { previewSyncFromRepo, SyncError, syncFromRepo } from "./sync.ts";
import { startWatcher } from "./watch.ts";
import { PORT } from "./config.ts";
import { OriginImportService, type AssignOriginRequest } from "./import.ts";
import { summarizeOrigin } from "./origin.ts";
import {
	createGithubRepositoryReader,
	GithubOriginMetadataCache,
} from "./githubOriginMetadata.ts";
import {
	evidenceRegistryRoot,
	listProposals,
	readActiveRegistry,
	registryPaths,
	writeProposal,
} from "./evidenceStore.ts";
import { checkRegistrySources, fetchSourceContent } from "./evidenceCheck.ts";
import { ApprovalError, approveProposal } from "./evidenceApprove.ts";
import { nextFirstFriday1000, scheduleRegistryCheck } from "./evidenceSchedule.ts";
import { buildAgentVariantMatrix } from "./variantMatrix.ts";
import {
	VerifiedApplyService,
	ApplyError,
	type ApplyTarget,
} from "./apply.ts";
import type { AdaptationReview } from "./adaptationReview.ts";
import {
	cachedAdaptationReview,
	MemoryReviewCache,
} from "./reviewCache.ts";

// Resident cache for Adaptation Reviews (ticket #6). Keyed by
// (skill, canonical revision, agent-profile revision); an unchanged pair reuses
// the prior analysis without regenerating it. Pure/in-memory: no machine
// paths, no filesystem.
const adaptationReviewCache = new MemoryReviewCache();

const __dirname = dirname(fileURLToPath(import.meta.url));
const githubOriginMetadata = new GithubOriginMetadataCache(
	join(
		process.env.SM_CACHE_DIR ?? join(homedir(), ".skill-manager"),
		"github-origins.json",
	),
	createGithubRepositoryReader({
		apiBaseUrl: process.env.SM_GITHUB_API_BASE,
		token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
	}),
);

// Never let an unhandled rejection or exception kill the server - log it and
// keep serving. (A handler that throws after writeHead used to crash node.)
process.on("unhandledRejection", (reason) => {
	console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (error) => {
	console.error("uncaughtException:", error);
});

let cachedInventory: ReturnType<typeof scanAll> | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

// SSE clients waiting for inventory-updated events
const sseClients = new Set<ServerResponse>();

// Body index for /api/search: name -> SKILL.md raw text, cached 60s.
let bodyCache: { at: number; bodies: Map<string, string> } | null = null;

async function skillBodies(
	inv: ReturnType<typeof scanAll>,
): Promise<Map<string, string>> {
	if (bodyCache && Date.now() - bodyCache.at < 60_000) return bodyCache.bodies;
	const bodies = new Map<string, string>();
	for (const [name, copies] of Object.entries(inv.byName)) {
		if (!copies || copies.length === 0) continue;
		try {
			bodies.set(name, readFileSync(copies[0].path, "utf8"));
		} catch {
			// unreadable skill - skip, the name itself still matches in /api/search
		}
	}
	bodyCache = { at: Date.now(), bodies };
	return bodies;
}

function broadcastInventoryUpdated(): void {
	const payload = `event: inventory\ndata: {"type":"inventory-updated"}\n\n`;
	for (const res of sseClients) {
		try {
			res.write(payload);
		} catch {
			sseClients.delete(res);
		}
	}
}

function invalidateAndRescan(): void {
	cachedInventory = null;
	cacheTime = 0;
	try {
		cachedInventory = scanAll();
		cacheTime = Date.now();
	} catch {
		cachedInventory = null;
	}
	broadcastInventoryUpdated();
}

function getInventory() {
	const now = Date.now();
	if (cachedInventory && now - cacheTime < CACHE_TTL) {
		return cachedInventory;
	}
	cachedInventory = scanAll();
	cacheTime = now;
	return cachedInventory;
}

function evidencePaths() {
	return registryPaths(evidenceRegistryRoot());
}

/**
 * Discovery roots per agent, used to deploy applied revisions to the runtime
 * copies. Honest defaults (env-overridable); codex has no scan location but is
 * a first-class variant target, so its default home is used here only.
 */
function deriveDeployTargets(skill: string): ApplyTarget[] {
	const home =
		process.env.USERPROFILE || process.env.HOME || homedir();
	const map: [AgentId, string][] = [
		["pi", process.env.SM_PI_SKILLS ?? join(home, ".pi", "agent", "skills")],
		["claude", process.env.SM_CLAUDE_SKILLS ?? join(home, ".claude", "skills")],
		["opencode", process.env.SM_OPENCODE_SKILLS ?? join(home, ".agents", "skills")],
		["codex", process.env.SM_CODEX_SKILLS ?? join(home, ".codex", "skills")],
	];
	return map.map(([agent, root]) => ({ agent, path: join(root, skill) }));
}

function originDetails(name: string) {
	const inv = getInventory();
	const copies = inv.byName[name] ?? [];
	const managed = copies.some((copy) => copy.location === "repo");
	let manifest;
	try {
		manifest = loadRepoManifest();
	} catch {
		manifest = null;
	}
	const record = manifest?.skills?.[name];
	const summary = summarizeOrigin(record?.origin, record?.identity, managed);
	let metadata = null;
	if (summary.state === "github" && summary.identity) {
		try {
			metadata = githubOriginMetadata.get(summary.identity);
		} catch {
			metadata = null;
		}
	}
	return { summary, metadata };
}

/**
 * Build an Adaptation Review for a skill given a baseline (current canonical)
 * and an upstream revision. Upstream content is read from an explicit body,
 * the manifest's pinned identity, or the detected upstream; when no content
 * can be obtained, the honest error matches /api/update's stance. The result
 * is returned through the resident cache (keyed by skill + canonical revision
 * + agent-profile revision) so an unchanged pair costs no regeneration.
 */
/**
 * Resolve the baseline (current canonical) and upstream (incoming) content for a
 * skill, plus the active agent-evidence registry. Shared by the Adaptation
 * Review endpoint AND the verified-apply endpoint so both derive the exact same
 * canonical content (no drift between the reviewed analysis and the applied
 * revision). Upstream content comes from an explicit body, the manifest's
 * pinned identity, or the detected upstream; when unavailable, the honest error
 * matches /api/update's stance.
 */
async function resolveReviewInput(
	name: string,
	body: Record<string, unknown>,
): Promise<{
	baselineContent: string;
	baselineRevision: string;
	upstreamContent: string;
	upstreamRevision: string;
	registry: ReturnType<typeof readActiveRegistry> | undefined;
}> {
	let manifest;
	try {
		manifest = loadRepoManifest();
	} catch {
		manifest = null;
	}
	const identity = manifest?.skills?.[name]?.identity;
	const inv = getInventory();
	const copies = inv.byName[name] ?? [];
	const repoCopy = copies.find((copy) => copy.location === "repo");

	let baselineContent: string;
	let baselineRevision: string;
	if (typeof body.baselineContent === "string") {
		baselineContent = body.baselineContent;
		baselineRevision = typeof body.baselineRevision === "string" ? body.baselineRevision : "provided";
	} else if (repoCopy) {
		baselineContent = readFileSync(repoCopy.path, "utf-8");
		baselineRevision = identity?.pinnedRevision || "current";
	} else {
		throw new SyncError("no canonical (repo) copy is available as the baseline");
	}

	let upstreamContent: string;
	let upstreamRevision: string;
	if (typeof body.upstreamContent === "string") {
		upstreamContent = body.upstreamContent;
		upstreamRevision = typeof body.upstreamRevision === "string" ? body.upstreamRevision : "incoming";
	} else {
		const upstreamRevisionForFetch =
			typeof body.upstreamRevision === "string"
				? body.upstreamRevision
				: identity?.pinnedRevision ?? "";
		const source: { url: string; subpath: string } | null =
			typeof body.upstreamUrl === "string" && typeof body.subpath === "string"
				? { url: body.upstreamUrl as string, subpath: body.subpath as string }
				: identity
					? { url: identity.upstreamUrl, subpath: identity.subpath }
					: copies[0]?.upstream
						? { url: copies[0].upstream as string, subpath: "." }
						: null;
		upstreamRevision = upstreamRevisionForFetch;
		if (!source || !upstreamRevision) {
			throw new SyncError(
				"no pinned upstream source for this skill - add an identity or supply upstreamContent",
			);
		}
		const service = new GitUpstreamUpdateService();
		try {
			const snapshot = await service.fetchSnapshot(
				{ url: source.url, subpath: source.subpath, pinnedRevision: upstreamRevision },
				upstreamRevision,
			);
			const file = snapshot.files.find(
				(f) => f.path.endsWith("SKILL.md") && typeof f.content === "string",
			);
			if (!file || typeof file.content !== "string") {
				throw new SyncError("upstream SKILL.md not found at the requested revision");
			}
			upstreamContent = file.content;
		} finally {
			service.dispose();
		}
	}

	let registry;
	try {
		registry = readActiveRegistry(evidencePaths().activeRegistryPath);
	} catch {
		registry = undefined;
	}

	return {
		baselineContent,
		baselineRevision,
		upstreamContent,
		upstreamRevision,
		registry,
	};
}

/**
 * Build an Adaptation Review for a skill given a baseline (current canonical)
 * and an upstream revision. Surfaced through the resident cache.
 */
async function runAdaptationReview(
	name: string,
	body: Record<string, unknown>,
): Promise<ReturnType<typeof cachedAdaptationReview>> {
	const input = await resolveReviewInput(name, body);
	return cachedAdaptationReview(
		{
			skill: name,
			baselineRevision: input.baselineRevision,
			upstreamRevision: input.upstreamRevision,
			baselineContent: input.baselineContent,
			upstreamContent: input.upstreamContent,
			registry: input.registry,
		},
		adaptationReviewCache,
	);
}

// Scheduled check: fetch official sources and place a pending proposal in
// Attention. It NEVER activates a revision - only an explicit approve does.
function runScheduledRegistryCheck(): void {
	const paths = evidencePaths();
	void (async () => {
		try {
			const active = readActiveRegistry(paths.activeRegistryPath);
			const proposal = await checkRegistrySources(active, fetchSourceContent, {
				createdBy: "scheduled-check",
			});
			writeProposal(paths.attentionDir, proposal);
			console.log(
				`[registry] check produced proposal ${proposal.id}: ${proposal.summary}`,
			);
		} catch (error) {
			console.warn("[registry] scheduled check failed:", error);
		}
	})();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 64 * 1024) throw new SyncError("Request body is too large.");
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
	} catch {
		throw new SyncError("Request body must be valid JSON.");
	}
}

function isSyncRequest(value: unknown): value is {
	name: string;
	targets: Array<{ path: string; sha: string }>;
} {
	if (!value || typeof value !== "object") return false;
	const request = value as { name?: unknown; targets?: unknown };
	return (
		typeof request.name === "string" &&
		Array.isArray(request.targets) &&
		request.targets.every(
			(target) =>
				target &&
				typeof target === "object" &&
				typeof (target as { path?: unknown }).path === "string" &&
				typeof (target as { sha?: unknown }).sha === "string",
		)
	);
}

/** Coerce an /api/origin request body into an AssignOriginRequest (never trusts shape). */
function coerceAssignRequest(
	value: unknown,
	requireSha: boolean,
): AssignOriginRequest {
	if (!value || typeof value !== "object") {
		throw new SyncError("Origin requests need a skill name and an origin object.");
	}
	const body = value as Record<string, unknown>;
	if (typeof body.name !== "string" || !body.name.trim()) {
		throw new SyncError("Origin requests need a skill name.");
	}
	if (!body.origin || typeof body.origin !== "object") {
		throw new SyncError("Origin requests need an origin object.");
	}
	const origin = body.origin as Record<string, unknown>;
	const request: AssignOriginRequest = {
		skillName: body.name,
		...(typeof body.category === "string" && body.category.trim()
			? { category: body.category }
			: {}),
		origin: {
			type: typeof origin.type === "string" ? origin.type : "",
			reason: typeof origin.reason === "string" ? origin.reason : "",
			...(typeof origin.attribution === "string"
				? { attribution: origin.attribution }
				: {}),
			...(typeof origin.ownershipNote === "string"
				? { ownershipNote: origin.ownershipNote }
				: {}),
			...(typeof origin.url === "string" ? { url: origin.url } : {}),
			...(typeof origin.subpath === "string" ? { subpath: origin.subpath } : {}),
		},
		expectedContentSha:
			typeof body.expectedContentSha === "string"
				? body.expectedContentSha
				: "",
		...(typeof body.pinnedRevision === "string"
			? { pinnedRevision: body.pinnedRevision }
			: {}),
		...(typeof body.sourcePath === "string"
			? { sourcePath: body.sourcePath }
			: {}),
	};
	if (requireSha && !request.expectedContentSha) {
		throw new SyncError(
			"expectedContentSha is required (from the approved preview).",
		);
	}
	return request;
}

const server = createServer(
	async (req: IncomingMessage, res: ServerResponse) => {
		console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);

		const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

		if (req.method === "GET" && url.pathname === "/") {
			try {
				const html = readFileSync(
					join(__dirname, "public", "index.html"),
					"utf-8",
				);
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(html);
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Failed to load index.html");
			}
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/inventory") {
			const inv = getInventory();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(inv));
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/manifest") {
			try {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ manifest: loadRepoManifest() }));
			} catch (error) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/skill") {
			const name = url.searchParams.get("name");
			if (!name) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing ?name parameter" }));
				return;
			}
			const inv = getInventory();
			const copies = inv.byName[name];
			if (!copies || copies.length === 0) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: `Skill '${name}' not found` }));
				return;
			}
			const repoCopy = copies.find((c) => c.location === "repo");
			const firstCopy = repoCopy ?? copies[0];
			let fullText = "";
			try {
				fullText = readFileSync(firstCopy.path, "utf-8");
			} catch {
				fullText = "";
			}
			// Include every copy's text (for drift diffs)
			const texts: { location: string; text: string }[] = [];
			for (const c of copies) {
				try {
					texts.push({
						location: c.location,
						text: readFileSync(c.path, "utf-8"),
					});
				} catch {
					texts.push({ location: c.location, text: "" });
				}
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ name, copies, fullText, texts }));
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/variant-matrix") {
			const name = url.searchParams.get("name");
			if (!name) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing ?name parameter" }));
				return;
			}
			const inv = getInventory();
			const copies = inv.byName[name];
			if (!copies || copies.length === 0) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Skill not found" }));
				return;
			}
			let manifestRecord;
			try {
				manifestRecord = loadRepoManifest()?.skills[name];
			} catch {
				manifestRecord = undefined;
			}
			let registry;
			try {
				registry = readActiveRegistry(evidencePaths().activeRegistryPath);
			} catch {
				registry = undefined;
			}
			const home =
				process.platform === "win32" && process.env.USERPROFILE
					? process.env.USERPROFILE
					: process.env.HOME || process.env.USERPROFILE || "";
			const matrix = buildAgentVariantMatrix({
				skill: name,
				copies,
				repoGitRoot: repoRoot(),
				manifestRecord,
				registry,
				profiles: DISCOVERY_PROFILES,
				home,
			});
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(matrix));
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/actions") {
			const inv = getInventory();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ actions: buildHealthActions(inv) }));
			return;
		}

		if (
			req.method === "POST" &&
			url.pathname === "/api/adaptation-review/apply"
		) {
			// Verified apply transaction (ticket #7): stage -> deploy -> verify ->
			// commit -> push the approved Adaptation Review to agent-skills/main.
			// A deployment/verification failure restores prior local copies and
			// reports (no commit/push). A rejected push keeps the verified local
			// commit and writes an Attention item - never an automatic rebase.
			try {
				const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
				const name = body?.name;
				if (typeof name !== "string" || !name.trim()) {
					throw new SyncError("Apply requests need a skill name.");
				}
				const review = body?.review;
				if (!review || typeof review !== "object") {
					throw new SyncError("Apply requests need an approved Adaptation Review.");
				}
				// Re-derive the exact canonical content the review analyzed so the
				// committed revision matches the reviewed analysis (no network when
				// the review was generated from inline upstreamContent).
				const input = await resolveReviewInput(name, body ?? {});
				const category =
					typeof body.category === "string" && body.category.trim()
						? body.category.trim()
						: undefined;
				const targets: ApplyTarget[] =
					Array.isArray(body.targets) && body.targets.length
						? (body.targets as Array<{ agent?: unknown; path?: unknown }>).map(
								(t) => ({
									agent: String(t.agent) as AgentId,
									path: String(t.path),
								}),
							)
					: deriveDeployTargets(name);
				const service = new VerifiedApplyService();
				const result = await service.apply(repoRoot(), {
					skill: name,
					canonicalContent: input.upstreamContent,
					canonicalRevision: input.upstreamRevision,
					review: review as AdaptationReview,
					targets,
					category,
				});
				invalidateAndRescan();
				res.writeHead(result.committed ? 200 : 409, {
					"Content-Type": "application/json",
				});
				res.end(JSON.stringify(result));
			} catch (error) {
				const status =
					error instanceof ApplyError
						? 409
						: error instanceof SyncError
							? 400
							: 500;
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error:
							error instanceof Error ? error.message : String(error),
					}),
				);
			}
			return;
		}

		if (
			(req.method === "GET" || req.method === "POST") &&
			url.pathname === "/api/adaptation-review"
		) {
			const queryName = url.searchParams.get("name");
			let body: Record<string, unknown> = {};
			if (req.method === "POST") {
				try {
					const parsed = (await readJsonBody(req)) as Record<string, unknown>;
					if (parsed && typeof parsed === "object") body = parsed;
				} catch {
					body = {};
				}
			} else {
				body = {};
				const q = url.searchParams;
				const pass = (key: string): string | undefined => {
					const v = q.get(key);
					return v === null ? undefined : v;
				};
				const br = pass("baselineRevision");
				const ur = pass("upstreamRevision");
				const uu = pass("upstreamUrl");
				const sp = pass("subpath");
				if (br) body.baselineRevision = br;
				if (ur) body.upstreamRevision = ur;
				if (uu) body.upstreamUrl = uu;
				if (sp) body.subpath = sp;
			}
			const name = queryName || (typeof body.name === "string" ? body.name : "");
			if (!name) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing skill name (?name or body.name)" }));
				return;
			}
			try {
				const review = await runAdaptationReview(name, body);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(review));
			} catch (error) {
				const badRequest = error instanceof SyncError;
				res.writeHead(badRequest ? 409 : 502, {
					"Content-Type": "application/json",
				});
				res.end(
					JSON.stringify({
						error:
							error instanceof Error
								? error.message
								: "Adaptation review failed.",
					}),
				);
			}
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/sync-preview") {
			const name = url.searchParams.get("name");
			if (!name) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing ?name parameter" }));
				return;
			}
			try {
				// Compute FIRST, then write headers - a throw after writeHead
				// makes the catch's writeHead throw "headers already sent",
				// which escapes the catch and crashes the server.
				const preview = previewSyncFromRepo(getInventory(), name);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(preview));
			} catch (error) {
				res.writeHead(409, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error:
							error instanceof Error ? error.message : "Sync preview failed.",
					}),
				);
			}
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/sync") {
			try {
				const request = await readJsonBody(req);
				if (!isSyncRequest(request)) {
					throw new SyncError(
						"Sync requests need a skill name and selected targets.",
					);
				}
				const result = syncFromRepo(
					getInventory(),
					request.name,
					request.targets,
				);
				cachedInventory = null;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(result));
			} catch (error) {
				res.writeHead(409, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: error instanceof Error ? error.message : "Sync failed.",
					}),
				);
			}
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/snapshot") {
			try {
				const snapshot = renderSnapshot(getInventory());
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Disposition":
						"attachment; filename=skill-manager-snapshot.html",
				});
				res.end(snapshot);
			} catch {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Failed to generate snapshot" }));
			}
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/upstream") {
			const name = url.searchParams.get("name");
			if (!name) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing ?name parameter" }));
				return;
			}
			const inv = getInventory();
			const copies = inv.byName[name];
			if (!copies || copies.length === 0) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Skill not found" }));
				return;
			}
			const upstream = copies[0].upstream;
			if (!upstream) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						name,
						upstream: null,
						note: "no upstream detected",
					}),
				);
				return;
			}
			const localSha = copies[0].sha;
			const result = await checkUpstream(name, upstream, localSha);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ name, upstream, ...result }));
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/upstream-batch") {
			// Check every skill that declares an upstream. Uses the shared 1h cache
			// from upstream.ts, so repeated runs are cheap. Bounded concurrency.
			const inv = getInventory();
			const entries: { name: string; upstream: string; sha: string }[] = [];
			for (const [name, copies] of Object.entries(inv.byName)) {
				const upstream = copies[0].upstream;
				if (!upstream) continue;
				entries.push({ name, upstream, sha: copies[0].sha });
			}
			const results: Record<
				string,
				{ upstream: string; stale: boolean; error?: string }
			> = {};
			const CONCURRENCY = 4;
			let cursor = 0;
			async function worker(): Promise<void> {
				while (cursor < entries.length) {
					const entry = entries[cursor++];
					const r = await checkUpstream(entry.name, entry.upstream, entry.sha);
					results[entry.name] = {
						upstream: entry.upstream,
						stale: !!r.stale,
						error: r.error,
					};
				}
			}
			await Promise.all(
				Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () =>
					worker(),
				),
			);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					checked: Object.keys(results).length,
					stale: Object.values(results).filter((r) => r.stale).length,
					results,
				}),
			);
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/search") {
			// Literal full-text search across SKILL.md bodies. Local and instant -
			// no embeddings. Index is cached briefly so repeated searches are fast.
			const q = (url.searchParams.get("q") || "").trim().toLowerCase();
			if (!q) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing ?q parameter" }));
				return;
			}
			const inv = getInventory();
			const bodies = await skillBodies(inv);
			const results: {
				name: string;
				description: string;
				locations: string[];
				snippet: string;
			}[] = [];
			for (const [name, text] of bodies) {
				const copies = inv.byName[name];
				if (!copies || copies.length === 0) continue;
				const lower = text.toLowerCase();
				const desc = (copies[0].description || "").toLowerCase();
				const inName = name.toLowerCase().includes(q);
				const inDesc = desc.includes(q);
				const inBody = lower.includes(q);
				if (!inName && !inDesc && !inBody) continue;
				const idx = inBody ? lower.indexOf(q) : 0;
				const start = Math.max(0, idx - 60);
				const end = Math.min(text.length, idx + q.length + 90);
				const snippet =
					(start > 0 ? "..." : "") +
					text.slice(start, end).replace(/\s+/g, " ").trim() +
					(end < text.length ? "..." : "");
				results.push({
					name,
					description: copies[0].description || "",
					locations: copies.map((c) => c.location),
					snippet,
				});
			}
			results.sort((a, b) => a.name.localeCompare(b.name));
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ query: q, count: results.length, results }));
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/compat") {
			// Portability report: skill x agent status derived from the knowledge
			// base in compat.ts (pure function over the inventory's frontmatter fields).
			const inv = getInventory();
			const report = compatReport(inv.byName);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(report));
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/explain") {
			// First-class explain: per-agent verdicts of how (and whether) this
			// runtime discovers the skill, plus compatibility. Reason codes are
			// the stable contract; prose is rendered UI-side.
			const name = url.searchParams.get("name");
			if (!name) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing ?name parameter" }));
				return;
			}
			const inv = getInventory();
			const copies = inv.byName[name];
			if (!copies || copies.length === 0) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Skill not found" }));
				return;
			}
			const compat = compatReport(inv.byName).skills.find(
				(s) => s.name === name,
			);
			const home =
				process.platform === "win32" && process.env.USERPROFILE
					? process.env.USERPROFILE
					: process.env.HOME || process.env.USERPROFILE || "";
			const agents = {} as Record<string, unknown>;
			for (const id of AGENT_IDS) {
				const profile = DISCOVERY_PROFILES[id];
				// filesystem probe: mark which discovery paths actually exist
				if (profile) {
					for (const p of profile.paths) {
						const resolved = p.path.replace(/^~/, home);
						if (!resolved.includes(":") && !resolved.startsWith("--")) {
							try {
								p.exists = statSync(resolved).isDirectory();
							} catch {
								p.exists = false;
							}
						}
					}
					profile.checkedAt = new Date().toISOString();
				}
				agents[id] = {
					...resolveExplain(id, profile, copies, home),
					profile: profile
						? {
								runtimeVersion: profile.runtimeVersion,
								evidence: profile.evidence,
								checkedAt: profile.checkedAt,
								paths: profile.paths.map((p) => ({
									path: p.path,
									kind: p.kind,
									exists: p.exists,
								})),
							}
						: undefined,
					compatibility: compat?.agents[id] ?? null,
				};
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					name,
					generatedAt: new Date().toISOString(),
					agents,
				}),
			);
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/variant") {
			// Create a variant for an agent from the repo copy (canonical content),
			// stored in the sidecar store. Returns the adaptation report.
			let body = "";
			for await (const chunk of req) body += chunk;
			let payload: { name?: string; agent?: string } = {};
			try {
				payload = JSON.parse(body || "{}");
			} catch {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid JSON body" }));
				return;
			}
			const name = payload.name;
			const agent = payload.agent;
			if (!name || !agent || !AGENT_IDS.includes(agent as AgentId)) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: "name + agent (pi|claude|codex|opencode) required",
					}),
				);
				return;
			}
			const inv = getInventory();
			const copies = inv.byName[name];
			const repoCopy = copies?.find((c) => c.location === "repo");
			if (!repoCopy) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({ error: "no repo copy to use as canonical source" }),
				);
				return;
			}
			try {
				const content = readFileSync(repoCopy.path, "utf-8");
				const artifact = createVariant(
					repoRoot(),
					name,
					agent as AgentId,
					content,
				);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(artifact));
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error:
							err instanceof Error ? err.message : "variant creation failed",
					}),
				);
			}
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/variant/deploy") {
			// Deploy a stored variant to an agent discovery path, then verify it
			// (removed fields gone, spec 4b). Deployment is verified afterward; a failure is reported, not automatically rolled back.
			let body = "";
			for await (const chunk of req) body += chunk;
			let payload: { name?: string; agent?: string; targetPath?: string } = {};
			try {
				payload = JSON.parse(body || "{}");
			} catch {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid JSON body" }));
				return;
			}
			const { name, agent, targetPath } = payload;
			if (!name || !agent || !targetPath) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({ error: "name + agent + targetPath required" }),
				);
				return;
			}
			try {
				const storePath = join(variantStoreRoot(repoRoot()), name, agent);
				deployVariant(storePath, targetPath);
				// re-create the adapt report for verification by re-adapting the
				// canonical copy (same inputs as creation)
				const inv = getInventory();
				const repoCopy = inv.byName[name]?.find((c) => c.location === "repo");
				const canonical = repoCopy ? readFileSync(repoCopy.path, "utf-8") : "";
				const adapt = adaptSkill(canonical, agent as AgentId);
				const deployedContent = readFileSync(
					join(targetPath, "SKILL.md"),
					"utf-8",
				);
				const verified = verifyDeployedVariant(
					deployedContent,
					adapt,
					agent as AgentId,
				);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						skill: name,
						agent,
						deployedTo: targetPath,
						verified,
						adapt: {
							removed: adapt.removed,
							added: adapt.added,
							carryOver: adapt.carryOver,
						},
					}),
				);
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: err instanceof Error ? err.message : "deploy failed",
					}),
				);
			}
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/update") {
			// Update preview: needs a pinned upstream source from the manifest
			// (spec: identity = upstreamUrl + subpath + pinnedRevision, never
			// HEAD-guessing). No manifest entry -> honest 404 with a path forward.
			const name = url.searchParams.get("name");
			if (!name) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing ?name parameter" }));
				return;
			}
			let manifest;
			try {
				manifest = readManifestSync(join(repoRoot(), "skillmgr.yaml"));
			} catch {
				manifest = null;
			}
			const identity = manifest?.skills?.[name]?.identity;
			if (!identity || !identity.upstreamUrl) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error:
							"no pinned upstream source for this skill in skillmgr.yaml - add an identity entry to enable updates",
						name,
					}),
				);
				return;
			}
			try {
				const service = new GitUpstreamUpdateService();
				const inv = getInventory();
				const copies = inv.byName[name] || [];
				// preview is read-only: any local copy works as the current baseline
				// (apply still requires a repo mirror - reported honestly)
				const baseline = copies.find((c) => c.location === "repo") || copies[0];
				if (!baseline) {
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							error: "no local copy of this skill to preview against",
						}),
					);
					return;
				}
				const preview = await service.preview({
					skillId: name,
					source: {
						url: identity.upstreamUrl,
						subpath: identity.subpath || ".",
						pinnedRevision: identity.pinnedRevision,
					},
					targetRevision: identity.pinnedRevision,
					// the local mirror of THIS skill (repo copy preferred), not the whole skills dir
					repoMirrorPath: dirname(baseline.path),
				});
				// honesty gate (review): report whether the baseline is actually a
				// repo mirror - apply is impossible without one, and an installed
				// copy must never be presented as the mirror
				const isRepoMirror = baseline.location === "repo";
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						...preview,
						applyAvailable: isRepoMirror,
						baselineLocation: baseline.location,
						note: isRepoMirror
							? "baseline is the repo mirror - apply can proceed after acknowledgement"
							: `baseline is an installed copy (${baseline.location}), not the repo mirror - adopt the skill into the repo before apply`,
					}),
				);
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: err instanceof Error ? err.message : "update preview failed",
					}),
				);
			}
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/origin") {
			// Cache-only origin read. This route never contacts GitHub.
			const name = url.searchParams.get("name");
			if (!name) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing ?name parameter" }));
				return;
			}
			const { summary, metadata } = originDetails(name);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({ name, ...summary, githubMetadata: metadata }),
			);
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/origin/refresh") {
			// The only origin-workspace route that contacts GitHub. Existing cached
			// facts remain untouched if validation or the network request fails.
			try {
				const body = await readJsonBody(req);
				const name = (body as { name?: unknown })?.name;
				if (typeof name !== "string" || !name.trim()) {
					throw new SyncError("Origin refresh requests need a skill name.");
				}
				const { summary } = originDetails(name);
				if (summary.state !== "github" || !summary.identity) {
					res.writeHead(409, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							error:
								"Only a verified public GitHub origin can refresh GitHub facts.",
						}),
					);
					return;
				}
				const metadata = await githubOriginMetadata.refresh(
					summary.identity,
					new Date().toISOString(),
				);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						name,
						...summary,
						githubMetadata: metadata,
					}),
				);
			} catch (error) {
				const badRequest = error instanceof SyncError;
				res.writeHead(badRequest ? 400 : 502, {
					"Content-Type": "application/json",
				});
				res.end(
					JSON.stringify({
						error:
							error instanceof Error
								? error.message
								: "GitHub metadata refresh failed.",
					}),
				);
			}
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/origin/preview") {
			// Read-only: validate the origin and show exactly what an assign would
			// import (content hash + target). Nothing is written, committed, or pushed.
			try {
				const body = await readJsonBody(req);
				const request = coerceAssignRequest(body, false);
				const service = new OriginImportService();
				const preview = await service.preview(repoRoot(), request);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(preview));
			} catch (error) {
				res.writeHead(409, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error:
							error instanceof Error ? error.message : "Origin preview failed.",
					}),
				);
			}
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/origin/assign") {
			// Perform the approved assignment/import: re-verify the content hash,
			// write canonical content + provenance, commit, then push. A rejected
			// push leaves the local commit inspectable and retryable (reported, not
			// auto-rebased or reset).
			try {
				const body = await readJsonBody(req);
				const request = coerceAssignRequest(body, true);
				const service = new OriginImportService();
				const result = await service.assign(repoRoot(), request);
				invalidateAndRescan();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(result));
			} catch (error) {
				res.writeHead(409, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error:
							error instanceof Error ? error.message : "Origin assignment failed.",
					}),
				);
			}
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/events") {
			// Server-Sent Events: notifies connected dashboards when the inventory
			// changes (watch mode). Keep-alive every 15s.
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write(": connected\n\n");
			sseClients.add(res);
			const keepAlive = setInterval(() => {
				try {
					res.write(": keepalive\n\n");
				} catch {
					clearInterval(keepAlive);
					sseClients.delete(res);
				}
			}, 15_000);
			req.on("close", () => {
				clearInterval(keepAlive);
				sseClients.delete(res);
			});
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/refresh") {
			cachedInventory = null;
			const inv = getInventory();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(inv));
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/evidence-registry") {
			try {
				const paths = evidencePaths();
				const active = readActiveRegistry(paths.activeRegistryPath);
				const proposals = listProposals(paths.attentionDir);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						active,
						proposals,
						nextRunAt: nextFirstFriday1000(new Date()).toISOString(),
					}),
				);
			} catch (error) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error:
							error instanceof Error ? error.message : String(error),
					}),
				);
			}
			return;
		}

		if (
			req.method === "POST" &&
			url.pathname === "/api/evidence-registry/check"
		) {
			// On-demand check: fetch official sources and produce a pending
			// proposal. Does NOT activate anything (AC3).
			try {
				const paths = evidencePaths();
				const active = readActiveRegistry(paths.activeRegistryPath);
				const proposal = await checkRegistrySources(
					active,
					fetchSourceContent,
					{ createdBy: "manual-check" },
				);
				writeProposal(paths.attentionDir, proposal);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ proposal, activated: false }));
			} catch (error) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error:
							error instanceof Error ? error.message : String(error),
					}),
				);
			}
			return;
		}

		if (
			req.method === "POST" &&
			url.pathname === "/api/evidence-registry/approve"
		) {
			// Approval gate: the ONLY path that changes the active registry.
			try {
				const body = await readJsonBody(req);
				const id = (body as { id?: unknown })?.id;
				if (typeof id !== "string" || !id.trim()) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Missing proposal id" }));
					return;
				}
				const result = await approveProposal({
					repoRoot: evidenceRegistryRoot(),
					proposalId: id,
				});
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(result));
			} catch (error) {
				const status = error instanceof ApprovalError ? 409 : 500;
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error:
							error instanceof Error ? error.message : String(error),
					}),
				);
			}
			return;
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Not found" }));
	},
);

server.listen(PORT, "127.0.0.1", () => {
	console.log(`Skill Manager server running at http://127.0.0.1:${PORT}`);
	// Watch mode: re-scan + notify dashboards when skills change on disk.
	try {
		startWatcher(invalidateAndRescan);
		console.log("Watch mode active (re-scan on skill changes)");
	} catch (error) {
		console.warn("Watch mode failed to start:", error);
	}
	// Evidence registry: schedule the first-Friday 10:00 local check. It only
	// ever places a pending proposal; it never activates a revision.
	try {
		scheduleRegistryCheck(runScheduledRegistryCheck);
		console.log(
			`Registry check scheduled for ${nextFirstFriday1000(new Date()).toISOString()}`,
		);
	} catch (error) {
		console.warn("Registry scheduler failed to start:", error);
	}
});
