// Upstream check: compare a skill's local copy against its GitHub upstream.
// Best-effort, cached, timeout-bounded - never blocks or fails the inventory.

import { createHash } from "node:crypto";

const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

interface CacheEntry {
  result: UpstreamResult;
  at: number;
}

const cache = new Map<string, CacheEntry>();

export interface UpstreamResult {
  url: string;
  upstreamSha: string;
  stale: boolean;
  error?: string;
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function fetchRaw(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "skill-manager" },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function candidatePaths(owner: string, repo: string, name: string): string[] {
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD`;
  return [
    `${base}/${name}/SKILL.md`,
    `${base}/skills/${name}/SKILL.md`,
    `${base}/SKILL.md`,
    `${base}/src/${name}/SKILL.md`,
  ];
}

export async function checkUpstream(
  name: string,
  upstream: string,
  localSha: string,
): Promise<UpstreamResult> {
  const cached = cache.get(upstream + "|" + localSha);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  const parts = upstream.split("/");
  if (parts.length < 2) {
    return { url: upstream, upstreamSha: "", stale: false, error: "bad upstream" };
  }
  const [owner, repo] = [parts[0], parts[1]];

  for (const url of candidatePaths(owner, repo, name)) {
    const text = await fetchRaw(url);
    if (text === null) continue;
    const upstreamSha = sha(text);
    const result: UpstreamResult = {
      url,
      upstreamSha,
      stale: localSha !== upstreamSha,
    };
    cache.set(upstream + "|" + localSha, { result, at: Date.now() });
    return result;
  }

  const result: UpstreamResult = {
    url: `https://github.com/${owner}/${repo}`,
    upstreamSha: "",
    stale: false,
    error: "upstream SKILL.md not found",
  };
  cache.set(upstream + "|" + localSha, { result, at: Date.now() });
  return result;
}
