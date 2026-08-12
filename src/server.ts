import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanAll } from "./scanner.ts";
import { checkUpstream } from "./upstream.ts";
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
