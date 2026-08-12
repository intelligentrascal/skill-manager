import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { readFileSync, statSync } from "node:fs";
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
import { resolveExplain } from "./discovery.ts";
import { DISCOVERY_PROFILES } from "./discoveryProfiles.ts";
import { buildHealthActions } from "./health.ts";
import { renderSnapshot } from "./snapshot.ts";
import { previewSyncFromRepo, SyncError, syncFromRepo } from "./sync.ts";
import { startWatcher } from "./watch.ts";
import { PORT } from "./config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

		if (req.method === "GET" && url.pathname === "/api/actions") {
			const inv = getInventory();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ actions: buildHealthActions(inv) }));
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
			// (removed fields gone, spec 4b). Never leaves a failing variant.
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
});
