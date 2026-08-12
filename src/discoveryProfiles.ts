// Per-agent discovery profiles. Pi facts contributed by the pi-side review
// (validated against Pi 0.84.1 docs/skills.md, 2026-08-12). Others are honest
// about their evidence level - never guessed.

import type { DiscoveryProfile } from "./discovery.ts";

export const DISCOVERY_PROFILES: Record<string, DiscoveryProfile> = {
	pi: {
		agent: "pi",
		runtimeVersion: "0.84.1",
		evidence: "documented",
		paths: [
			{ path: "~/.pi/agent/skills", kind: "global", exists: true },
			{ path: "~/.agents/skills", kind: "global", exists: true },
			{ path: ".pi/skills", kind: "trusted-project" },
			{
				path: ".agents/skills",
				kind: "trusted-project",
				notes: [
					"Scanned from cwd through ancestors to git root, or filesystem root outside a repo.",
				],
			},
			{
				path: "package.json:skills/",
				kind: "package",
				notes: ["Package skill directories are discovered."],
			},
			{
				path: "package.json:pi.skills",
				kind: "package",
				notes: ["Pi package skill entries are discovered."],
			},
			{
				path: "settings.skills[]",
				kind: "explicit",
				notes: ["Global or project settings can add skill files/directories."],
			},
			{
				path: "--skill <path>",
				kind: "explicit",
				notes: ["Repeatable, additive even with --no-skills."],
			},
		],
		precedence: ["explicit", "package", "trusted-project", "global"],
		precedenceEvidence: "inferred",
		trustRequiredKinds: ["trusted-project"],
		notes: [
			"Project resources require trusted-project approval; otherwise they are blocked.",
			"Explicit --skill paths remain enabled with --no-skills.",
			"Same-name collisions warn and Pi keeps the first discovered skill.",
			"Root .md files are discovered in ~/.pi/agent/skills and .pi/skills, but ignored at ~/.agents/skills and project .agents/skills.",
			"Scanner alone cannot establish settings/package/CLI explicit sources; those are unknown here.",
		],
	},
	claude: {
		agent: "claude",
		runtimeVersion: "2.x",
		evidence: "documented",
		paths: [
			{ path: "~/.claude/skills", kind: "global", exists: true },
			{ path: ".claude/skills", kind: "project" },
		],
		precedence: ["project", "global"],
		precedenceEvidence: "documented",
		trustRequiredKinds: [],
		notes: ["Claude Code discovers global and project skills; project wins on collision."],
	},
	codex: {
		agent: "codex",
		runtimeVersion: "unknown",
		evidence: "inferred",
		paths: [{ path: "~/.codex/skills", kind: "global" }],
		precedence: ["global"],
		precedenceEvidence: "inferred",
		trustRequiredKinds: [],
		notes: [
			"Agent Skills support exists but path semantics are unverified here; treat as inferred.",
		],
	},
	opencode: {
		agent: "opencode",
		runtimeVersion: "unknown",
		evidence: "inferred",
		paths: [
			{ path: "~/.agents/skills", kind: "global", exists: true },
			{ path: ".opencode/skills", kind: "project" },
		],
		precedence: ["project", "global"],
		precedenceEvidence: "inferred",
		trustRequiredKinds: [],
		notes: ["OpenCode loads Agent Skills; exact precedence unverified - inferred."],
	},
};
