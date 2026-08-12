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
import { PORT } from "./config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedInventory: ReturnType<typeof scanAll> | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

function getInventory() {
	const now = Date.now();
	if (cachedInventory && now - cacheTime < CACHE_TTL) {
		return cachedInventory;
	}
	cachedInventory = scanAll();
	cacheTime = now;
	return cachedInventory;
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

		if (req.method === "GET" && url.pathname === "/api/snapshot") {
			try {
				const snapshot = renderSnapshot(getInventory());
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Disposition": "attachment; filename=skill-manager-snapshot.html",
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
});
