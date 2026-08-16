import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createGithubRepositoryReader,
	GithubOriginMetadataCache,
	type GithubRepositoryReader,
} from "../src/githubOriginMetadata.ts";

const IDENTITY = {
	upstreamUrl: "https://github.com/acme/skills.git",
	subpath: "skills/demo",
	pinnedRevision: "abc123",
};
const VERIFIED_AT = "2026-08-16T16:30:00.000Z";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
	return await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") reject(new Error("missing test port"));
			else resolve(address.port);
		});
	});
}

test("GitHub facts are persisted only by explicit refresh and then served from cache", async () => {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-github-metadata-"));
	const cachePath = join(root, "github-origins.json");
	let reads = 0;
	const reader: GithubRepositoryReader = async () => {
		reads += 1;
		return {
			ownerLogin: "acme",
			ownerAvatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
			repositoryName: "skills",
			repositoryUrl: "https://github.com/acme/skills",
			stars: 418,
		};
	};

	try {
		const cache = new GithubOriginMetadataCache(cachePath, reader);
		assert.equal(cache.get(IDENTITY), null);
		assert.equal(reads, 0, "reading cached facts must not contact GitHub");

		const refreshed = await cache.refresh(IDENTITY, VERIFIED_AT);
		assert.deepEqual(refreshed, {
			ownerLogin: "acme",
			ownerAvatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
			repositoryName: "skills",
			repositoryUrl: "https://github.com/acme/skills",
			stars: 418,
			verifiedAt: VERIFIED_AT,
		});
		assert.equal(reads, 1);

		const reloaded = new GithubOriginMetadataCache(cachePath, async () => {
			throw new Error("cache reads must not contact GitHub");
		});
		assert.deepEqual(reloaded.get(IDENTITY), refreshed);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("GitHub reader maps verified repository facts from the configured API", async () => {
	let requestedPath = "";
	const server = createServer((request, response) => {
		requestedPath = request.url ?? "";
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({
			name: "skills",
			html_url: "https://github.com/acme/skills",
			stargazers_count: 418,
			owner: {
				login: "acme",
				avatar_url: "https://avatars.githubusercontent.com/u/42?v=4",
			},
		}));
	});
	const port = await listen(server);
	try {
		const reader = createGithubRepositoryReader({
			apiBaseUrl: `http://127.0.0.1:${port}`,
			timeoutMs: 1_000,
		});
		const facts = await reader({
			owner: "acme",
			repo: "skills",
			cloneUrl: "https://github.com/acme/skills.git",
		});
		assert.equal(requestedPath, "/repos/acme/skills");
		assert.deepEqual(facts, {
			ownerLogin: "acme",
			ownerAvatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
			repositoryName: "skills",
			repositoryUrl: "https://github.com/acme/skills",
			stars: 418,
		});
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
