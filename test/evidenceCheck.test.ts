import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { defaultRegistry } from "../src/evidenceRegistry.ts";
import {
	checkRegistrySources,
	classifySource,
	type FetchResult,
} from "../src/evidenceCheck.ts";

const sha = (text: string) =>
	createHash("sha256").update(text).digest("hex");

test("classifySource: unchanged, changed, no-baseline, unreachable", () => {
	const at = "2026-08-16T10:00:00.000Z";
	const sameHash = sha("same");
	assert.deepEqual(classifySource(sameHash, { ok: true, text: "same" }, at), {
		status: "unchanged",
		currentHash: sameHash,
		note: "source content matches the recorded evidence",
	});
	const changed = classifySource(sameHash, { ok: true, text: "different" }, at);
	assert.equal(changed.status, "changed");
	const baseline = classifySource("", { ok: true, text: "first" }, at);
	assert.equal(baseline.status, "no-baseline");
	assert.equal(baseline.currentHash, sha("first"));
	const unreachable = classifySource("abc", { ok: false }, at);
	assert.equal(unreachable.status, "unreachable");
	assert.equal(unreachable.currentHash, "");
});

test("check builds a proposal and never mutates the active registry", async () => {
	const registry = defaultRegistry();
	const before = JSON.stringify(registry);
	const fetchFn = async (): Promise<FetchResult> => ({
		ok: true,
		text: "agentskills spec v2",
	});
	const proposal = await checkRegistrySources(registry, fetchFn, {
		createdBy: "manual-check",
		id: "p1",
		now: new Date("2026-08-16T10:00:00.000Z"),
	});
	// the check must not change the registry in place (AC3)
	assert.equal(JSON.stringify(registry), before);
	// pi + claude both fetch the spec; codex + opencode are blocked
	assert.equal(proposal.checks.length, 4);
	assert.equal(proposal.blockedCount, 2);
	assert.equal(proposal.changedCount, 0);
	assert.ok(
		proposal.checks.some((c) => c.agent === "codex" && c.status === "blocked"),
	);
	assert.ok(
		proposal.checks.some((c) => c.agent === "pi" && c.status === "no-baseline"),
	);
	assert.equal(proposal.status, "pending");
	assert.equal(proposal.baseRegistryVersion, registry.registryVersion);
});

test("a changed source is reported as changed with a review sample", async () => {
	const registry = defaultRegistry();
	// give the pi spec source a recorded baseline that will differ
	registry.profiles.pi.sources[0].contentHash = sha("old");
	const fetchFn = async (url: string): Promise<FetchResult> => ({
		ok: true,
		text: url.includes("agentskills") ? "brand new spec text" : "other",
	});
	const proposal = await checkRegistrySources(registry, fetchFn, {
		createdBy: "scheduled-check",
		now: new Date("2026-08-16T10:00:00.000Z"),
	});
	const piCheck = proposal.checks.find((c) => c.agent === "pi");
	assert.ok(piCheck);
	assert.equal(piCheck.status, "changed");
	assert.equal(piCheck.previousHash, sha("old"));
	assert.equal(piCheck.currentHash, sha("brand new spec text"));
	assert.ok(piCheck.sample, "changed sources include a review sample");
	assert.equal(proposal.changedCount, 1);
});

test("an unreachable fetch is reported, not guessed", async () => {
	const registry = defaultRegistry();
	const fetchFn = async (): Promise<FetchResult> => ({ ok: false });
	const proposal = await checkRegistrySources(registry, fetchFn, {
		createdBy: "manual-check",
		now: new Date("2026-08-16T10:00:00.000Z"),
	});
	const piCheck = proposal.checks.find((c) => c.agent === "pi");
	assert.ok(piCheck);
	assert.equal(piCheck.status, "unreachable");
	assert.equal(proposal.unreachableCount, 2); // pi + claude share the fetchable source
});
