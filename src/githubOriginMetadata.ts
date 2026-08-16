import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	parseGithubUrl,
	type GithubRepoRef,
	type OriginIdentitySummary,
} from "./origin.ts";

export interface GithubRepositoryFacts {
	ownerLogin: string;
	ownerAvatarUrl: string | null;
	repositoryName: string;
	repositoryUrl: string;
	stars: number;
}

export interface GithubOriginMetadata extends GithubRepositoryFacts {
	verifiedAt: string;
}

export type GithubRepositoryReader = (
	repository: GithubRepoRef,
) => Promise<GithubRepositoryFacts>;

export interface GithubRepositoryReaderOptions {
	apiBaseUrl?: string;
	timeoutMs?: number;
	token?: string;
}

/** Create the explicit network adapter used only by the refresh route. */
export function createGithubRepositoryReader(
	options: GithubRepositoryReaderOptions = {},
): GithubRepositoryReader {
	const apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(
		/\/$/,
		"",
	);
	const timeoutMs = options.timeoutMs ?? 8_000;
	return async (repository) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(
				`${apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
				{
					headers: {
						Accept: "application/vnd.github+json",
						"User-Agent": "skill-manager",
						...(options.token
							? { Authorization: `Bearer ${options.token}` }
							: {}),
					},
					signal: controller.signal,
				},
			);
			if (!response.ok) {
				throw new Error(`GitHub repository lookup failed with HTTP ${response.status}.`);
			}
			const body = (await response.json()) as Record<string, unknown>;
			const owner = body.owner as Record<string, unknown> | undefined;
			const facts: GithubRepositoryFacts = {
				ownerLogin: typeof owner?.login === "string" ? owner.login : "",
				ownerAvatarUrl:
					typeof owner?.avatar_url === "string" ? owner.avatar_url : null,
				repositoryName: typeof body.name === "string" ? body.name : "",
				repositoryUrl: typeof body.html_url === "string" ? body.html_url : "",
				stars:
					typeof body.stargazers_count === "number"
						? body.stargazers_count
						: -1,
			};
			const candidate: GithubOriginMetadata = {
				...facts,
				verifiedAt: new Date().toISOString(),
			};
			if (!isValidMetadata(candidate, repository)) {
				throw new Error(
					"GitHub repository response did not match the verified origin.",
				);
			}
			return facts;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error("GitHub repository lookup timed out.");
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	};
}

interface CacheDocument {
	version: 1;
	repositories: Record<string, GithubOriginMetadata>;
}

function emptyCache(): CacheDocument {
	return { version: 1, repositories: {} };
}

function repositoryKey(repository: GithubRepoRef): string {
	return `${repository.owner}/${repository.repo}`.toLowerCase();
}

function repositoryForIdentity(identity: OriginIdentitySummary): GithubRepoRef {
	const parsed = parseGithubUrl(identity.upstreamUrl);
	if (!parsed.ok) {
		throw new Error(`Invalid GitHub origin identity: ${parsed.error}`);
	}
	return parsed.ref;
}

function safeAvatarUrl(value: string | null): boolean {
	if (value === null) return true;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			["avatars.githubusercontent.com", "github.com"].includes(
				url.hostname.toLowerCase(),
			)
		);
	} catch {
		return false;
	}
}

function isValidMetadata(
	value: unknown,
	repository: GithubRepoRef,
): value is GithubOriginMetadata {
	if (!value || typeof value !== "object") return false;
	const metadata = value as Partial<GithubOriginMetadata>;
	return (
		typeof metadata.ownerLogin === "string" &&
		metadata.ownerLogin.toLowerCase() === repository.owner.toLowerCase() &&
		typeof metadata.repositoryName === "string" &&
		metadata.repositoryName.toLowerCase() === repository.repo.toLowerCase() &&
		metadata.repositoryUrl ===
			`https://github.com/${metadata.ownerLogin}/${metadata.repositoryName}` &&
		(metadata.ownerAvatarUrl === null ||
			typeof metadata.ownerAvatarUrl === "string") &&
		safeAvatarUrl(metadata.ownerAvatarUrl) &&
		Number.isSafeInteger(metadata.stars) &&
		(metadata.stars ?? -1) >= 0 &&
		typeof metadata.verifiedAt === "string" &&
		!Number.isNaN(Date.parse(metadata.verifiedAt))
	);
}

export class GithubOriginMetadataCache {
	private readonly cachePath: string;
	private readonly readRepository: GithubRepositoryReader;

	constructor(
		cachePath: string,
		readRepository: GithubRepositoryReader,
	) {
		this.cachePath = cachePath;
		this.readRepository = readRepository;
	}

	get(identity: OriginIdentitySummary): GithubOriginMetadata | null {
		const repository = repositoryForIdentity(identity);
		const cached = this.readDocument().repositories[repositoryKey(repository)];
		return isValidMetadata(cached, repository) ? cached : null;
	}

	async refresh(
		identity: OriginIdentitySummary,
		verifiedAt: string,
	): Promise<GithubOriginMetadata> {
		if (Number.isNaN(Date.parse(verifiedAt))) {
			throw new Error("GitHub metadata verification time must be an ISO date.");
		}
		const repository = repositoryForIdentity(identity);
		const facts = await this.readRepository(repository);
		const metadata: GithubOriginMetadata = { ...facts, verifiedAt };
		if (!isValidMetadata(metadata, repository)) {
			throw new Error("GitHub returned repository facts that do not match the origin.");
		}
		const document = this.readDocument();
		document.repositories[repositoryKey(repository)] = metadata;
		this.writeDocument(document);
		return metadata;
	}

	private readDocument(): CacheDocument {
		if (!existsSync(this.cachePath)) return emptyCache();
		try {
			const parsed = JSON.parse(readFileSync(this.cachePath, "utf8")) as Partial<CacheDocument>;
			if (
				parsed.version !== 1 ||
				!parsed.repositories ||
				typeof parsed.repositories !== "object" ||
				Array.isArray(parsed.repositories)
			) {
				return emptyCache();
			}
			return { version: 1, repositories: parsed.repositories };
		} catch {
			return emptyCache();
		}
	}

	private writeDocument(document: CacheDocument): void {
		mkdirSync(dirname(this.cachePath), { recursive: true });
		const temporaryPath = `${this.cachePath}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
		renameSync(temporaryPath, this.cachePath);
	}
}
