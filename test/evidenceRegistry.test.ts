import assert from "node:assert/strict";
import test from "node:test";
import {
	SEED_REGISTRY,
	bumpRegistryVersion,
	defaultRegistry,
	validateRegistry,
	RegistryValidationError,
} from "../src/evidenceRegistry.ts";

test("the seed registry validates and covers all four agents", () => {
	const registry = defaultRegistry();
	assert.doesNotThrow(() => validateRegistry(registry));
	for (const agent of ["pi", "claude", "codex", "opencode"] as const) {
		assert.ok(registry.profiles[agent], `${agent} profile present`);
	}
});

test("pi is documented with a content-addressed source and version", () => {
	const pi = SEED_REGISTRY.profiles.pi;
	assert.equal(pi.evidence, "documented");
	assert.equal(pi.observedVersion, "0.84.1");
	assert.ok(pi.sources.length >= 2, "pi has spec + pinned package sources");
	const packageSource = pi.sources.find((s) => !s.fetchable);
	assert.ok(packageSource, "pi has a pinned (non-fetchable) package source");
	assert.ok(packageSource.contentHash.length === 64, "package docs content-addressed");
	const spec = pi.sources.find((s) => s.fetchable);
	assert.ok(spec, "pi has a fetchable spec source");
	assert.ok(pi.behavior.some((b) => b.field === "description" && b.treatment === "requires"));
	assert.ok(pi.behavior.some((b) => b.field === "allowed-tools" && b.treatment === "honors"));
});

test("codex and opencode are inferred with no fetchable source (never guessed)", () => {
	for (const agent of ["codex", "opencode"] as const) {
		const profile = SEED_REGISTRY.profiles[agent];
		assert.equal(profile.evidence, "inferred");
		assert.equal(profile.observedVersion, "unknown");
		assert.equal(profile.sources.length, 0);
		assert.ok(profile.notes.some((n) => /blocked/i.test(n)));
	}
});

test("every behavior claim and constraint carries a valid evidence level", () => {
	const registry = defaultRegistry();
	const evidence = ["documented", "inferred", "unknown"];
	for (const profile of Object.values(registry.profiles)) {
		for (const claim of profile.behavior) {
			assert.ok(evidence.includes(claim.evidence), `${profile.agent} ${claim.field}`);
		}
		for (const constraint of profile.constraints) {
			assert.ok(evidence.includes(constraint.evidence), `${profile.agent} constraint`);
		}
		assert.ok(profile.constraints.length > 0, `${profile.agent} has constraints`);
	}
});

test("validateRegistry rejects a wrong schema version", () => {
	const bad = defaultRegistry();
	(bad as { schemaVersion: number }).schemaVersion = 99;
	assert.throws(() => validateRegistry(bad), RegistryValidationError);
});

test("validateRegistry rejects a missing profile", () => {
	const bad = defaultRegistry();
	delete (bad.profiles as Record<string, unknown>).codex;
	assert.throws(() => validateRegistry(bad), RegistryValidationError);
});

test("bumpRegistryVersion increments the patch segment", () => {
	assert.equal(bumpRegistryVersion("1.0.0"), "1.0.1");
	assert.equal(bumpRegistryVersion("1.2.9"), "1.2.10");
	assert.throws(() => bumpRegistryVersion("one"), RegistryValidationError);
});

test("defaultRegistry returns an independent copy of the seed", () => {
	const a = defaultRegistry();
	const b = defaultRegistry();
	a.profiles.pi.name = "mutated";
	assert.notEqual(b.profiles.pi.name, "mutated");
});
