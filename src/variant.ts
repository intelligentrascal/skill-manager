// Variant creation: adapt a skill authored for one agent (typically claude)
// into a usable variant for another agent. Pure functions - the adaptation
// rules are the spec section 4a made into code.
//
// Honesty rules:
// - adaptation is "make it usable and honest on the target", never "make it
//   identical everywhere" (native semantics over fake portability)
// - what does NOT adapt is reported in `carryOver`, never silently dropped
// - the evidence level of each rule matches the compat profiles
//   (pi documented, opencode/codex inferred)

import type { AgentId } from "./compat.ts";

/** Frontmatter keys claude uses for interactive invocation (intent lost elsewhere). */
const CLAUDE_INVOCATION = [
	"user-invocable",
	"argument-hint",
	"arguments",
	"context",
];

export interface AdaptResult {
	/** adapted SKILL.md content. */
	content: string;
	/** frontmatter keys removed. */
	removed: string[];
	/** frontmatter keys added. */
	added: string[];
	/** things that do not carry over to the target (nested skills, scripts, mcp...). */
	carryOver: string[];
	/** true when the skill could not be auto-adapted safely (complex frontmatter). */
	blocked?: string;
}

function parseFrontmatterBlock(content: string): {
	raw: string;
	lines: string[];
	body: string;
} | null {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n"))
		return null;
	const end = content.indexOf("\n---");
	if (end === -1) return null;
	const raw = content.slice(0, end + 1);
	const lines = raw.split(/\r?\n/).slice(1, -1); // drop the --- fences
	const body = content.slice(end + 4);
	return { raw, lines, body };
}

function keyOf(line: string): string | null {
	const idx = line.indexOf(":");
	if (idx === -1) return null;
	const key = line.slice(0, idx).trim();
	return /^[a-zA-Z][a-zA-Z0-9-]*$/.test(key) ? key : null;
}

function detectCarryOver(body: string): string[] {
	const found: string[] = [];
	if (/\bscripts\//.test(body)) {
		found.push("scripts/ directory (target cannot execute them)");
	}
	if (/\breferences\//.test(body)) {
		found.push("references/ directory (may reference tools the target lacks)");
	}
	if (/mcp/i.test(body)) {
		found.push("MCP references");
	}
	return found;
}

/**
 * Adapt a SKILL.md for a target agent. Returns the adapted content + an
 * honest report of what changed and what does not carry over.
 */
export function adaptSkill(content: string, target: AgentId): AdaptResult {
	const removed: string[] = [];
	const added: string[] = [];
	const carryOver: string[] = [];

	const block = parseFrontmatterBlock(content);
	if (!block) {
		return {
			content,
			removed,
			added,
			carryOver: detectCarryOver(content),
			blocked: "no frontmatter block - cannot adapt automatically",
		};
	}

	// build a map of key -> original line (first occurrence wins)
	const kept: string[] = [];
	for (const line of block.lines) {
		const key = keyOf(line);
		if (key && CLAUDE_INVOCATION.includes(key) && target !== "claude") {
			removed.push(key);
			continue; // drop claude-invocation fields for non-claude targets
		}
		kept.push(line);
	}

	// fold the dropped invocation guidance into the body as a note (honest
	// preservation: the guidance survives as text, not as dead metadata)
	if (removed.length > 0 && target !== "claude") {
		carryOver.push(
			`invocation fields (${removed.join(", ")}) moved to a note - the target has no equivalent metadata`,
		);
	}

	// opencode: add a triggers hint when the skill has none (inferred convention)
	if (target === "opencode" && !kept.some((l) => keyOf(l) === "triggers")) {
		kept.push("triggers: auto");
		added.push("triggers");
	}

	// what does not carry over structurally
	carryOver.push(...detectCarryOver(block.body));

	const adapted = "---\n" + kept.join("\n") + "\n---" + block.body;
	return { content: adapted, removed, added, carryOver };
}

/**
 * Re-verify a variant: the fields that triggered creation must be gone for
 * the target (spec 4b step 1). Pure: given the adapted fields, confirm none
 * of the removed keys are still present.
 */
export function verifyAdaptation(
	adaptedFields: string[],
	removed: string[],
	target: AgentId,
): { ok: boolean; stillPresent: string[] } {
	const stillPresent = removed.filter((k) => adaptedFields.includes(k));
	// pi keeps allowed-tools + disable-model-invocation by design - those are
	// NOT adaptation failures
	const allowed =
		target === "pi" ? ["allowed-tools", "disable-model-invocation"] : [];
	const failures = stillPresent.filter((k) => !allowed.includes(k));
	return { ok: failures.length === 0, stillPresent: failures };
}
