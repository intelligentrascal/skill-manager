import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanAll } from "./scanner.ts";
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

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);

  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    try {
      const html = readFileSync(join(__dirname, "public", "index.html"), "utf-8");
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
    const repoCopy = copies.find(c => c.location === "repo");
    const firstCopy = repoCopy ?? copies[0];
    let fullText = "";
    try {
      fullText = readFileSync(firstCopy.path, "utf-8");
    } catch {
      fullText = "";
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name, copies, fullText }));
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
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Skill Manager server running at http://127.0.0.1:${PORT}`);
});
