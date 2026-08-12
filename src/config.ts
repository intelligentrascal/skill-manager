import { homedir } from "node:os";
import { join } from "node:path";

// Scan locations are configurable via environment variables so the app is
// portable: SM_PI_SKILLS, SM_OPENCODE_SKILLS, SM_CLAUDE_SKILLS,
// SM_SHARED_SKILLS, SM_REPO_SKILLS (nested category layout). Defaults fit a
// typical multi-harness setup on Windows/macOS/Linux.
const home = homedir();

export interface ScanLocation {
	name: string;
	root: string;
	nested?: boolean;
}

export const SCAN_LOCATIONS: ScanLocation[] = [
	{ name: "pi", root: process.env.SM_PI_SKILLS ?? join(home, ".pi", "agent", "skills") },
	{ name: "opencode", root: process.env.SM_OPENCODE_SKILLS ?? join(home, ".config", "opencode", "skills") },
	{ name: "claude", root: process.env.SM_CLAUDE_SKILLS ?? join(home, ".claude", "skills") },
	{ name: "shared", root: process.env.SM_SHARED_SKILLS ?? join(home, ".agents", "skills") },
	{ name: "repo", root: process.env.SM_REPO_SKILLS ?? join(home, "Documents", "9. Projects", "agent-skills", "skills"), nested: true },
];

export const PORT = Number(process.env.SM_PORT) > 0 ? Number(process.env.SM_PORT) : 7788;

export function repoRoot(): string {
	// The git repo containing the `repo` location (for repoClean checks).
	const repo = SCAN_LOCATIONS.find((l) => l.name === "repo");
	if (!repo) return "";
	return join(repo.root, "..");
}
