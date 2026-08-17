# Direct Skill Manager Competitors and Near-Peers

- **Ticket:** [intelligentrascal/skill-manager#15](https://github.com/intelligentrascal/skill-manager/issues/15) (child of [#11 - UX/UI wayfinder map](https://github.com/intelligentrascal/skill-manager/issues/11))
- **Date:** 2026-08-17
- **Status:** Research only. No implementation, no GitHub issue changes, no resolved-decision claim.
- **Evidence posture:** Shared evidence rule (`~/.pi/agent/skills/_shared/evidence-rule.md`) - trust classes, proximity to origin, independent corroboration, no-evidence labeling.
- **Companion note:** [2026-08-17-benchmark-five-skill-management-interface-types.md](./2026-08-17-benchmark-five-skill-management-interface-types.md) (ticket #13) covers cross-category analogies (VS Code, chezmoi, Backstage, n8n, GitHub Actions, Anthropic Agent Skills). This note is the direct competitive landscape and should be read with it.

## Executive synthesis

This is a young but crowded category. Eleven candidate products were examined from first-party sources (all cloned/read at source level); ten are true direct competitors - tools whose primary job is managing Agent Skills across multiple agent runtimes - and one (lasoons/AgentSkillsManager) is an adjacent IDE-extension-scoped near-peer. The landscape converged within roughly seven months (earliest repo 2026-01-08, latest 2026-08-13) and already shows two distinct architectural camps:

1. **The disposition managers** (abubakarsiddik31, SkillDeck, tddworks, lasoons): read the filesystem, toggle/install/delete folders, minimal state model. Fast to build, no canonical anchor, no evidence about *why* a copy is what it is.
2. **The library/sync managers** (xingkongliang, jiweiyeah, mode-io, skilldock, HarnessKit, skillfish, asm): introduce a central managed library or manifest as the source of truth, then deploy to agents (copy, symlink, or CLI write). These dominate on stars (xingkongliang 3.8k) and feature surface.

**What Skill Manager should learn:**

- **The central-library pattern is the market's answer to the same fragmentation problem, and it is the strongest competitive pressure.** xingkongliang (3,799 stars, v1.34.2, active) and jiweiyeah (939 stars, v2.1.8) both ship a managed library + per-agent deploy model with workspaces and presets. Skill Manager's *repo-canonical* model is a deliberate variant: the canonical copy lives in a git repo with provenance instead of a local `~/.skills-manager` library. The redesign should make that repo-canonical distinction legible and valuable, or the market will read Skill Manager as a weaker copy of these.
- **Every serious product ships per-agent enable/disable and update-check surfaces; almost none ship preview-before-write or verified apply.** skilldock (Git-aware diff preview + hunk revert) and xingkongliang (held-back-removals guard, safety snapshots before conflict resolution) are the closest to Skill Manager's preview/confirm discipline - and even they stop short of verified apply with rollback. Skill Manager's safety contracts remain a defensible moat; the UI must present them as a feature, not a wall.
- **Security scanning is becoming table stakes.** asm (pre-install shell/network/credential scan), HarnessKit (18 static rules, trust scores 0-100, per-agent re-audit, permission transparency across filesystem/network/shell/db/env), mode-io (LLM-backed scans), and jiweiyeah (ClawHub publish preflight + MIT-0 explicit consent) all treat skill trust as a first-class surface. Skill Manager has origin/provenance evidence but no content-scan; the redesign should expose a security posture visibly (borrow HarnessKit's trust-score tiering as a *pattern*, not necessarily the scoring).
- **Provenance and origin tracking are differentiation opportunities, not commodity features.** skillfish pins refs in a manifest, xingkongliang tracks device + per-skill merge, HarnessKit tracks origin per extension ("HarnessKit tracks the source so you always know where each extension came from"), skilldock tracks upstream git source + who updated. None of them record *canonical origin evidence* (verified URL, subpath, pinned revision, append-only history) the way Skill Manager does. That is the clearest positioning gap to lean into.
- **Cross-platform desktop is the standard delivery form** (Tauri dominates: abubakarsiddik31, xingkongliang, jiweiyeah, skilldock, HarnessKit; Swift on macOS for SkillDeck/tddworks; CLIs via npm for skillfish/asm). Skill Manager is currently a local web dashboard on 127.0.0.1 - the redesign should consider whether the desktop-app expectation (tray, keyboard-first, dark UI) changes the entry-surface decision, while keeping the local-only, no-account contract.

Detailed per-product profiles follow, then a comparison matrix and a borrow/reject synthesis.

## Method and evidence level

- All eleven candidate repositories were shallow-cloned (git, at HEAD) and read at source level: README (EN + ZH where present), key source files (adapters, commands, components, package.json/Cargo.toml for versions), CHANGELOG/RELEASE_NOTES where present. GitHub API metadata (stars, forks, created/pushed dates, latest release tags, release dates, artifact signing) was fetched directly. This is **fidelity level 1 (raw bytes)**; trust class is **Codebase/runtime** for source reads and **Web** (GitHub API, first-party) for metadata.
- Screenshots referenced in READMEs were **not downloaded and visually verified** in this pass (no vision verification run); claims about UI visuals rest on the products' own README text + screenshot captions and are labeled as such. This is the one place the evidence is the vendor's own description (interested-party) rather than direct observation - flagged, not hidden.
- The ticket's adjacent list (skills.sh, SkillsMP, agentskill.sh, Skill MarketPlace, SwarmSkills, AgentX, OmniDev) was **not product-investigated**; the separation section classifies them using only what the competitor READMEs evidence (skills.sh, ClawHub, MCP.Directory, smithery are referenced by multiple READMEs) plus the ticket's own naming. Anything else about them is labeled not-evidenced.

---

## True direct competitors (10)

Ranked roughly by maturity/star count. Each profile covers: runtime coverage; local/remote model; source of truth; discovery/search/install/sync/update/enable-disable/edit/diff/provenance/security/rollback; navigation/workspace; target user; positioning; strengths; weaknesses; maturity + evidence confidence; borrow/reject.

### 1. xingkongliang/skills-manager - "Skills Manager" (Tauri desktop + CLI)

**Sources:** repo cloned (README, CHANGELOG, docs), GitHub API. Created 2026-03-02; v1.34.2 released 2026-08-16 (Keep-a-Changelog + SemVer); **3,799 stars / 330 forks**; Rust/Tauri 2 + React 19 + SQLite; active.

**Runtime coverage:** 52 agents out of the box (Claude Code, Codex, Cursor, Copilot, Gemini CLI, OpenCode, OpenClaw, Hermes, OpenHands, Cline, Goose, Windsurf, Continue, Grok, Antigravity, Qwen Code, Crush, Kilo Code, Roo Code, Amp, Kiro, Droid, TRAE, Warp, Qoder, CodeBuddy, ...), plus custom tools with user-defined paths.

**Local/remote model:** Local-first desktop + CLI sharing one SQLite database and sync engine. Remote optional: GitHub device-flow sign-in creates a private `skills-manager-backup` repo; "The remote stays a plain Git repository - you can `git clone` it anywhere, no lock-in."

**Source of truth:** A central library - "Everything goes into one central repo, which defaults to `~/.skills-manager` and can be customized in Settings." The SQLite DB holds metadata ("rebuilt from the skill files"); secrets never leave the machine; skills over 100 MB are excluded from backup.

**Discovery/search/install:** Install from Git repos, local folders, `.zip`/`.skill` archives, or the skills.sh marketplace; "Marketplace + AI search - browse popular skills... or enable SkillsMP AI search with your API key." Per-skill `skills search` CLI hits skills.sh with no API key.

**Sync/update:** "Automatic: local changes are committed and pushed in the background a couple of minutes after you stop editing"; skill-aware merging (renames merge by skill, not per text line); conflicts "never block or overwrite" - the skill keeps the local version and appears under **Needs attention** with keep-mine/use-remote/keep-both, "a safety snapshot is taken before any choice is applied, so every decision is undoable." Update guard: "An update replaces the skill's folder, so if the new version lacks paths that exist now, the CLI applies nothing and lists them as `held_back_removals` instead - confirming the loss needs a person, so only the app can proceed." Snapshots & restore on the Backup page; restore first snapshots the current state.

**Enable/disable/deploy:** Presets are one-time copies ("Applying a preset is a one-time copy - not a live sync"); per-agent deployment via `skills deploy <ref> --agent claude_code --agent codex`; undeploy with `--dry-run`. Workspaces: Global / Agent / Project / Linked (a directory pointed to as a skills root, outside default agent paths).

**Edit/diff:** Not a headline feature in the captured sources; edits happen through the library and re-deploy. Diff surfaced mainly as update/drift ("A project copy you had just edited could be reported as the older side... Both sides of the comparison now come from the files themselves" - v1.34.2 changelog, an explicit drift-fix).

**Navigation/workspace:** Sidebar with Library (Untagged filter, per-card delete), Presets, Global Workspace (per-agent pages), Project Workspaces, Backup page, Settings; `+ Add Skills` sheet with always-visible agent-target chips and select-all/clear; in-app Help mirroring the product flow.

**Target user / positioning:** The power multi-agent user who wants one library + presets + multi-device sync. Positioning: "One app to manage AI agent skills across all your coding tools."

**Strengths:** Largest adoption; real sync/backup story (Git-based, conflict-safe); presets as a strong interaction primitive; CLI + desktop on one core; 52-agent coverage; active release train.
**Weaknesses:** No verified apply / content security scanning evidenced; conflict resolution is user-choice based, not evidence-based; provenance is device/repo history, not canonical-origin verification; library model competes directly with Skill Manager's repo-canonical model.

**Maturity/evidence confidence:** High maturity (v1.34, large community). Evidence: README + CHANGELOG + API - codebase-class for what the repo says, but no runtime verification performed (all products in this note).

**Borrow:** the preset-as-one-time-deploy primitive; the "Needs attention" conflict bucket with undoable choices (snapshot before decision); held-back-removals guard (matches Skill Manager's unknown/blocked honesty); workspace scoping (global/agent/project).
**Reject:** central local library replacing the repo-canonical anchor (loses provenance + audit); auto-push sync in the background (Skill Manager's change model is explicit, evidence-first).

### 2. jiweiyeah/Skills-Manager - "Skills Manager" (Tauri desktop)

**Sources:** repo cloned (README, DESIGN.md, SECURITY.md, PRIVACY.md), GitHub API. Created 2026-02-06; **v2.1.8** (2026-08-09); **939 stars / 60 forks**; Tauri 2 + React 19 + Tailwind + Radix; active.

**Runtime coverage:** "30+ supported AI tools (Claude Code, Codex, Cursor, Gemini CLI, Windsurf, Trae, Cline, Augment, Goose, and many more), extensible via custom tools."

**Local/remote model:** Local desktop; symlink-based sync: "It uses a powerful **symlink synchronization mechanism**, allowing you to write a skill once and instantly use it across 30+ supported AI tools." Remote = publishing to the ClawHub marketplace (v2.1.8: one-click "Publish to ClawHub").

**Source of truth:** "Centralize all your AI skills in one secure location"; per-tool enable/disable without deleting originals ("Enable or disable specific skills for individual tools").

**Discovery/search/install:** Marketplace ("Browse, install, and share community-contributed skills directly within the app"), AI translation of skill names/descriptions/content via LLM, command palette (`Cmd/Ctrl+K`), bilingual UI (EN/ZH).

**Update/sync:** Symlink model means "your tools always have the latest version of your skills without file duplication" - a live-link model rather than copy-sync. Publish flow (ClawHub) has real safety detail: preflight lists files + total size, derives slug + suggested version, local validation of category enum/reserved topics/semver and 10 MB/file + 50 MB total limits, published badge with slug+version, "Updates reuse the slug and owner from the previous publish... instead of creating a duplicate." Security/privacy: "ClawHub requires every skill to be published under the MIT-0 license... This must be confirmed explicitly in the publish dialog - the app never accepts it on your behalf." PRIVACY.md and SECURITY.md exist.

**Navigation/workspace:** Raycast-style UI ("Beautiful Raycast-style interface"), command palette, sidebar tool views.

**Target user / positioning:** Multi-tool users who want write-once-use-everywhere via symlinks plus a marketplace/publish story. Positioning: "A unified desktop application for managing AI coding assistant skills... Seamlessly organize, sync, and share skills."

**Strengths:** Strong adoption; symlink model avoids duplication; publish-to-marketplace with real preflight + explicit license consent; command palette; custom tools.
**Weaknesses:** Symlink live-link means a change in the library instantly changes every agent - no preview/confirm gate; no drift/evidence model; provenance limited to publish records; MIT-0-only publishing is restrictive but enforced transparently.

**Maturity/evidence confidence:** High (v2.1.8, months of releases). Evidence: README + DESIGN.md + release notes - codebase-class for repo claims.

**Borrow:** explicit-consent license acknowledgment at publish (pattern for Skill Manager's security-review gates); preflight-with-local-validation before any remote publish; command palette as a primary navigation affordance.
**Reject:** the always-live symlink model (Skill Manager's verified-apply contract requires explicit promotion); market-place-publishing as a core feature.

### 3. mode-io/skill-manager - "Skill Manager" (local-first control center)

**Sources:** repo cloned (README EN/ZH), GitHub API. Created 2026-04-07; **v0.3.1** (2026-05-19); 114 stars / 13 forks; TypeScript frontend + Python backend; distributed via Homebrew tap + npm (`@mode-io/skill-manager`), native artifacts with published sha256 checksums; active-ish (pushed 2026-07-30).

**Runtime coverage:** Codex CLI, Claude Code, Cursor, OpenCode, Hermes Agent, OpenClaw (macOS/Linux); Windows x64 initial support is Codex-CLI + Skills only. Table of harness x (Skills | MCP servers | Slash commands).

**Local/remote model:** "A local-first control center for AI extensions" - local state; discovery is remote (marketplaces).

**Source of truth:** One shared inventory: "Adopt local Skills into one shared inventory, then enable or disable them per harness"; slash commands as "one shared prompt library" synced to harnesses; MCP servers as shared config records written into each tool's config.

**Discovery/search/install:** Marketplace surface with three catalogs: Skills Marketplace, MCP Marketplace, CLI Marketplace (CLIs.dev - "display-only; Skill Manager does not install or manage CLIs").

**Scan/security:** "Run LLM-backed security checks against Skills before trusting them" (Scan product idea) - LLM-provider-config saved, findings reviewed before use.

**Attention model:** The four product ideas are literally "In use / Needs review / Scan / Discover": "**Needs review** - Skill Manager found local state, config differences, or inventory issues that need a decision."

**Enable/disable/edit/diff:** Per-harness enable/disable; adopt existing harness command files; resolve config differences; no verified-apply contract evidenced.

**Navigation/workspace:** Overview (whole extension portfolio: in use / needs review / discoverable / where active), Skills, MCP, Slash commands, Marketplace sections; skill matrix views per harness.

**Target user / positioning:** The operator managing extensions (skills + MCP + slash commands) across harnesses with a review-first posture. Positioning: "A local-first control center for AI extensions... Use, review, scan, and discover."

**Strengths:** Explicit review/attention language ("Needs review") matches Skill Manager's Attention concept; multi-extension-type scope (skills + MCP + slash commands); security scan as a named product idea; Homebrew/npm distribution with checksums.
**Weaknesses:** Smallest coverage of the desktop pack (6 harnesses); LLM-backed scanning is vendor-config-dependent, not evidence-grounded; no provenance/canonical model evidenced.

**Maturity/evidence confidence:** Medium (v0.3.x, 114 stars). Evidence: README + release artifacts - codebase-class for repo claims.

**Borrow:** the "Needs review" state as a named first-class surface (Skill Manager's Attention queue, corroborated); scan-before-trust as a product idea; per-harness capability matrix in docs.
**Reject:** LLM-only security verdicts without provenance (Skill Manager should keep evidence-grounded profiles; an LLM scan can supplement, not replace).

### 4. crossoverJie/SkillDeck - "SkillDeck" (macOS desktop GUI)

**Sources:** repo cloned (README, README_CN, docs/DEVELOPMENT.md, package), GitHub API. Created 2026-02-11; **v0.0.26** (2026-06-25, ~400 downloads on latest zip); 535 stars / 38 forks; Swift 5.9+/macOS 14+; active-ish (pushed 2026-07-07).

**Runtime coverage:** 12 agents with a documented detection model (binary + dir) and per-agent "Skills Reading Priority" (e.g. Codex: own dir -> `~/.agents/skills/` shared global; OpenCode: own -> `~/.claude/skills` -> `~/.agents/skills`). This reading-priority table is the best-evidenced discovery model in the landscape.

**Local/remote model:** Local desktop; "The filesystem is the database - skills are directories containing SKILL.md files"; remote = registry browsing (skills.sh leaderboard + ClawHub catalog for OpenClaw).

**Source of truth:** The per-agent filesystem folders; no central library evidenced (reads what is installed and installs/updates into agent dirs).

**Discovery/search/install:** "Registry & Marketplace Browser - Browse skills.sh leaderboard plus the ClawHub catalog for OpenClaw with search, sorting, and filters"; "Flexible Imports - Install from GitHub or import from a local folder, then auto-create symlinks and update the lock file."

**Update:** "Update Checker - Detect remote changes and pull updates with one click"; v0.0.26 changelog shows status fixes ("make Up to Date status persistent in skill detail page") - an explicit status surface.

**Edit:** "SKILL.md Editor - Split-pane form + markdown editor with live preview"; "Agent Assignment - Toggle..." per agent.

**Navigation/workspace:** "Unified Dashboard - All skills in one three-pane macOS-native view"; dashboard + registry + skill detail + install views (screenshots in README, not visually verified).

**Target user / positioning:** macOS power users of multiple AI code agents who want a native three-pane manager. Positioning: "The desktop GUI for managing AI code agent skills on macOS" - "the first desktop GUI for managing skills across multiple AI code agents."

**Strengths:** Documented per-agent discovery precedence (valuable reference for Skill Manager's Explain engine); lock-file + symlink install; three-pane native UI; registry browsing.
**Weaknesses:** macOS-only; small release cadence/age; filesystem-as-database = no provenance beyond lock file; no security scan.

**Maturity/evidence confidence:** Medium (v0.0.x, 535 stars). Evidence: README + DEVELOPMENT.md + release notes - codebase-class for repo claims.

**Borrow:** the per-agent reading-priority table as UI content for Explain (Skill Manager already computes this; SkillDeck proves users want it as a table); "Up to Date" status persistence on a skill detail page.
**Reject:** macOS-only delivery (Skill Manager's Windows user is primary); filesystem-only truth with no canonical anchor.

### 5. wanghuan9/skilldock - "SkillDock" (Tauri desktop)

**Sources:** repo cloned (README, README.zh-CN, docs), GitHub API. Created 2026-05-13; **v1.0.11** (2026-08-17, artifacts signed with `.sig`); 446 stars / 21 forks; Rust/Tauri; very active (pushed 2026-08-17).

**Runtime coverage:** "Claude Code, Cursor, Codex, Windsurf, Gemini CLI, GitHub Copilot, IntelliJ IDEA, OpenCode, Antigravity, Continue, Qwen Code, Trae, Trae CN, Cline, Roo Code, Kilo Code, Kiro, Goose, Junie, Augment, CodeBuddy, Droid, OpenClaw, CommandCode, Crush, Qoder, Zencoder, Hermes, iFlow, Pi, OMP, Grok Build, MiMo Code, WorkBuddy" (~35).

**Local/remote model:** Local desktop; three package lifecycles (Skills / MCP servers / Plugins) each with install flows (skills.sh + ClawHub one-click, Git, local folder; MCP.Directory for MCP; Git for plugins).

**Source of truth:** The managed library `~/.skilldock/skills` is "the single distribution source" for managed skills, enabled into tools via symlinks; explicit managed-vs-unmanaged-vs-enabled model: "'Managed' identifies where a Skill's real files live and who owns its update and removal lifecycle. 'Enabled' means linking a managed Skill into Cursor, Claude Code, Codex, or another tool. Only managed Skills can be distributed centrally." Unmanaged tool-local skills can be imported into management. Agent Skills CLI compatibility: `~/.agents/skills` skills installed by `npx skills add -g` are scanned and distributed without being moved - "SkillDock can inspect and distribute them, with preview, update, and removal where Agent Skills CLI supports those operations."

**Diff/rollback:** "Review staged and unstaged diffs and incoming updates, and revert individual files or hunks"; "preview local changes before updating or pushing"; "Git-aware updates for tracking upstream changes and local modifications"; "seeing who updated the package and what changed" - team collaboration without intermediate handoff directories.

**Enable/disable/edit:** Per-tool enable/disable (skill, MCP server, plugin), per-tool sync targets; inspect/remove/import unmanaged skills; MCP tools discovery with tool-level enablement.

**Security:** Signed release artifacts; no content security scan evidenced (label: not-evidenced beyond signing).

**Navigation/workspace:** "Skills, MCP, and Plugins between list and card layouts, light/dark/system themes"; Tools page showing each tool's skill + MCP config locations as sync targets; skill detail with source + enablement; per-tool "managed, unmanaged, and conflicting entries" view.

**Target user / positioning:** The team/user who wants skills + MCP + plugins managed with git-aware update/diff and one-click distribution. Positioning: "AI skill manager for Claude Code, Cursor, Codex, Windsurf, and more... with Git-aware updates for tracking upstream changes and local modifications."

**Strengths:** The most complete diff/update story in the landscape (staged/unstaged/incoming diffs, hunk revert, who-updated-what); managed/unmanaged/enabled model is a clear mental model; broad tool coverage; signed releases; three package types in one surface.
**Weaknesses:** Young (v1.0.x, created May 2026); no provenance evidence model (git source tracking, not canonical-origin verification); no content security scan.

**Maturity/evidence confidence:** Medium-high (v1.0.11, active, signed). Evidence: README + docs + release metadata - codebase-class for repo claims.

**Borrow:** the managed/unmanaged/enabled three-way label as skill-row state (Skill Manager's OK/MIRROR/DRIFT should map to this vocabulary where it helps); staged/unstaged/incoming diff surfaces + hunk-level revert (the closest competitor analog to Skill Manager's preview/confirm); who-updated-what visibility for upstream updates.
**Reject:** nothing structural - SkillDock is the nearest safety-peer and validates Skill Manager's direction.

### 6. knoxgraeme/skillfish - "skillfish" (npm CLI)

**Sources:** repo cloned (README, package.json v1.0.31), GitHub API. Created 2026-01-21; 306 stars / 27 forks; TypeScript CLI on npm; active (pushed 2026-08-07).

**Runtime coverage:** 33 agents with a full directory table (Claude Code, Cursor, Windsurf, Codex, Copilot, Gemini CLI, OpenCode, Goose, Amp, Roo Code, Kiro, Kimi CLI, Kilo Code, Trae, Cline, Antigravity, Droid, Augment, OpenClaw, CodeBuddy, Command Code, Crush, Kode, Mistral Vibe, Mux, OpenClaude IDE, OpenHands, Qoder, Qwen Code, Replit, Trae CN, Neovate, AdaL).

**Local/remote model:** CLI-local; remote = skill.fish registry ("Browse and discover community skills") + MCP Market skills directory; `skillfish submit` publishes to skill.fish.

**Source of truth:** The installed agent directories + an explicit team manifest (`skillfish.json`): "Share skills across your team by committing a skillfish.json manifest to your repository." Manifest tracks external skills only; refs can be pinned (`owner/repo@v1.0.0`, `@main/skills/my-skill`).

**Discovery/search/install/sync/update:** `skillfish add <owner/repo>` installs "to all detected agents"; `list`, `remove`, `update`, `search <query>`, `bundle` (create manifest), `install` (from manifest, "Installs... Updates... Removes manifest-managed skills that are no longer listed"), `install --dry-run` ("Preview what would change"); "Manually installed skills (skillfish add) are protected from removal" - a deliberate safety rule.

**Security/rollback:** No content scan evidenced; dry-run preview is the safety surface; pinned refs in manifest.

**Navigation:** CLI commands + skill.fish web catalog; `--json` for automation.

**Target user / positioning:** CLI/agent users and teams wanting one-command install + team sync. Positioning: "The skill manager for AI coding agents. Install, update, and sync skills across Claude Code, Cursor, Copilot + more."

**Strengths:** Zero-install `npx skillfish add owner/repo`; team manifest with pinned refs and protected manual installs; dry-run; broad agent table.
**Weaknesses:** No GUI; no diff/verify beyond dry-run; no provenance beyond manifest refs; registry is community-run.

**Maturity/evidence confidence:** Medium (v1.0.31, 306 stars). Evidence: README + package.json - codebase-class for repo claims.

**Borrow:** manifest-with-pinned-refs as the team-share format (Skill Manager's `skillmgr.yaml` pinned revision is the same idea; skillfish proves the UX of `bundle`/`install`); "manually installed skills are protected from removal" as a safety rule for Skill Manager's sync flows.
**Reject:** no-GUI delivery (Skill Manager's redesign is explicitly UI).

### 7. luongnv89/asm - "agent-skill-manager (asm)" (npm CLI + optional TUI)

**Sources:** repo cloned (README, RELEASE_NOTES, CHANGELOG, SECURITY.md, CLEAN_CODE_AUDIT.md, prd.md, docs), GitHub API. Created 2026-03-11; **package v2.15.0**; 870 stars / 80 forks; TypeScript; very active (pushed 2026-08-10).

**Runtime coverage:** 19 providers: Claude Code, Codex, OpenClaw, Cursor, Windsurf, Cline, Roo Code, Continue, GitHub Copilot, Aider, OpenCode, Zed, Augment, Amp, Gemini CLI, Google Antigravity, Pi, Hermes, generic Agents; per-provider disable via `asm config edit`.

**Local/remote model:** CLI-local; remote catalog at luongnv.com/asm ("Browse 4,300+ skills"); bundles ("curated sets in one pass").

**Source of truth:** The installed agent folders + a local library option: "`asm install --library` - install once, `asm activate` per provider"; duplicate audit (`asm audit --yes` removes redundant skills).

**Discovery/search/install/update:** `asm list --json` (cross-provider inventory), `asm search`, `asm install github:user/repo` or by name, `asm inspect`, `asm stats`, `asm audit`, `asm update`; authoring pipeline `asm init` / `asm link` (live dev via symlink) / `asm eval` / `asm publish`; `asm bundle install`.

**Security:** The strongest CLI security story: "**Security scan** - `asm audit security` before install... Pre-install scan for shell exec, network access, credential exposure"; "`asm install` validates frontmatter, scans security, pins registry commits" - pinning installs to registry commits is a provenance primitive.

**Rollback/safety:** `--yes`/`--json`/`--machine` non-interactive; cross-tool linking/reinstall handling when a skill already exists in another tool; MIT-licensed, no accounts.

**Navigation:** CLI-first, optional TUI (`asm` with no args: "filter, inspect, and audit skills across every provider from one dashboard"); web catalog.

**Target user / positioning:** AI agents and automation pipelines ("a scriptable CLI built for AI agents and automation") plus humans via TUI. Positioning: "CLI to install and manage agent skills."

**Strengths:** Agent-parseable JSON everywhere (built for agents, not just humans); real pre-install security scan (shell/network/credentials); frontmatter validation + registry commit pinning; bundle concept; active.
**Weaknesses:** No GUI (TUI is optional); no diff/preview before writes beyond audit; no canonical repo model (library is local).

**Maturity/evidence confidence:** High (v2.15.0, 870 stars, active). Evidence: README + RELEASE_NOTES + package - codebase-class.

**Borrow:** pre-install security scan dimensions (shell exec / network / credential exposure) as Skill Manager's content-scan surface; pinning installs to registry commits (matches pinned-revision provenance); `--json` machine output as an API contract for the redesign's data layer.
**Reject:** audit-as-remove (`asm audit --yes` auto-removes duplicates - Skill Manager should surface, not auto-remove).

### 8. RealZST/HarnessKit - "HarnessKit" (Tauri desktop)

**Sources:** repo cloned (README EN/ZH, release metadata), GitHub API. Created 2026-03-27; **v1.8.2** (2026-08-09, artifacts include `.sig` signatures); 396 stars / 32 forks; Rust/Tauri; very active (pushed 2026-08-16).

**Runtime coverage:** 12 agents across five extension types (Skills, MCP, Plugins, Hooks, Agent-first CLIs): Claude Code, Codex, Gemini CLI, Cursor, Antigravity, Copilot, Devin Desktop, OpenCode, Hermes, Kiro, Oh My Pi, DeepSeek Harness; a per-agent capability matrix marks what each agent supports ("— indicates the agent currently does not support this extension type").

**Local/remote model:** Local desktop (+ web mode referenced in release notes); remote = three marketplaces: skills.sh (skills), Smithery (MCP), and an agent-CLI catalog.

**Source of truth:** The agent filesystems + tracked sources: "HarnessKit tracks the source so you always know where each extension came from"; same-repo extensions grouped into "packs" for batch management; origin tracking merges kit-installed extensions with their marketplace origin.

**Discovery/search/install:** Marketplace browsing with "description, install count, and source"; skills previewable (documentation) + "check third-party security audit scores before installing"; install to any agent one click; cross-agent deployment ("See which agents have the extension and which don't - deploy to any missing agent with one click. HarnessKit handles the format differences between agents (JSON, TOML, hook conventions, MCP schemas) automatically").

**Security (the standout):** "Every extension is scanned by a built-in security engine with 18 static analysis rules and receives a Trust Score (0-100)... Safe (80+), Low Risk (60-79), Needs Review (below 60). A dedicated Audit page... Every finding pinpoints the exact file and line number"; "Per-agent scanning - even if multiple agents share the same extension, each agent's copy is audited independently - because versions can drift"; permission transparency across five dimensions: "filesystem paths, network domains, shell commands, database engines, and environment variables."

**Update/enable/disable/rollback:** One-click update check across all extensions; per-extension enable/disable from the list; per-agent deployment; MCP transport-aware install ("install targets that can't take a server's transport are greyed out up front instead of receiving a config they can't load").

**Navigation/workspace:** Sidebar scope picker (Global / All scopes / registered project); Overview with all agents (installed or not - "switch to 'Detected only'... or flip a single agent's 'Enabled' toggle off"); Extensions list (filter by type/agent/source, packs); per-agent dashboard for configs/memory/rules/subagents/ignore; Audit page; Kits (portable `.hk-kit.zip` bundles deployable to projects).

**Target user / positioning:** The operator managing *everything* about multiple agents (extensions, configs, memory, rules) with security-first posture. Positioning: "One home for every agent... see, secure, and manage everything across every agent, from one place."

**Strengths:** Broadest scope (5 extension types + configs/memory/rules); best-in-class security surface (static rules, trust tiers, per-agent re-audit, permission transparency, file:line findings); cross-agent format translation; real-time config detection; kit bundles; signed releases; i18n (EN/ZH/zh-TW).
**Weaknesses:** Scope creep risk (skills are one of five types - less focused than Skill Manager); trust scores are heuristic, not evidence-grounded; no canonical repo/verified-apply; young (v1.8.x, May-ish 2026... created Mar 2026).

**Maturity/evidence confidence:** High-medium (v1.8.2, active, signed). Evidence: README + release notes + API - codebase-class for repo claims.

**Borrow:** trust-score tiering + per-agent re-audit + permission transparency (filesystem/network/shell/db/env) as the *shape* of Skill Manager's security posture (keep evidence labels, adopt the tiering language); transport/format-aware install gating ("greyed out up front instead of writing a config they can't load" - matches Skill Manager's block-don't-invent rule); scope picker (Global/All/project).
**Reject:** heuristic-only trust scores presented as authority (Skill Manager must keep documented/inferred/unknown evidence levels); managing hooks/configs/memory as core scope (stays out of Skill Manager's contract).

### 9. tddworks/SkillsManager - "Skills Manager" (macOS Swift app)

**Sources:** repo cloned (README, docs/ARCHITECTURE.md, prototype), GitHub API. Created 2026-01-08 (oldest in the set); 162 stars / 21 forks; Swift 6.2 / macOS 15+; pushed 2026-05-28 (less active).

**Runtime coverage:** 2 providers: Claude Code (`~/.claude/skills`) and Codex (`~/.codex/skills/public`).

**Local/remote model:** Local desktop; remote = GitHub catalogs (e.g. anthropics/skills) via `file://` or repo URLs.

**Source of truth:** Local installed skills (claude + codex) + remote catalogs that "OWN" their skills (`remoteCatalogs: [SkillsCatalog]`); install to one or both providers; uninstall/unlink.

**Discovery/search/install:** Browse remote catalogs, add multiple catalogs, search by name/description/tags; grid/list views; markdown rendering; split-pane editor with live preview; global custom tags ("Purple tags come from SKILL.md frontmatter; cyan tags are your custom tags").

**Edit:** Split-pane editor for local skills; "Uninstall / Unlink - Unlink from a provider or fully uninstall."

**Navigation/workspace:** Three-column layout: Sidebar (installed skills, provider filters, remote catalogs) / Main (grid or list, tag filtering) / Detail panel (skill info, tags, install/uninstall). Architecture documented (layered, SwiftUI Atomic Design, TDD, no ViewModel layer).

**Target user / positioning:** macOS developers using Claude Code + Codex who want browse/install/tag. Positioning: "A macOS application for discovering, browsing, installing, and tagging skills."

**Strengths:** Clean documented architecture; tag system (frontmatter vs custom, global) is a nice organizational primitive; split-pane live preview; multi-catalog.
**Weaknesses:** Only 2 providers; macOS 15+ only; low activity since May; no sync/update/provenance/security.

**Maturity/evidence confidence:** Low-medium (162 stars, stalled-ish). Evidence: README + ARCHITECTURE - codebase-class for repo claims.

**Borrow:** dual-tag model (frontmatter tags vs user tags, visually distinct colors) for Skill Manager's tag/filter surfaces; catalog-owns-skills domain model.
**Reject:** two-provider scope and per-app macOS delivery.

### 10. abubakarsiddik31/skill-manager - supplied peer (Tauri desktop)

**Sources:** analyzed in depth in the companion #13 note (repo cloned, source read: Rust adapters, React components, tests). Created 2026-08-13 (newest); **v0.3.1** (2026-08-16); 9 stars; Rust/Tauri; not code-signed.

**Summary (full profile in the #13 note, Category 2):** Disposition manager - enable/disable via reversible `.disabled/` folder move (test-proven round trip, symlink-aware), per-project views, "seen by N tools" chips, delete with confirm()-only, no preview-before-write, no drift/evidence/provenance model. Covers 11 tools + shared `~/.agents/skills`.

**Borrow (from #13):** reversible toggle with exact inverse; seen-by chips with role labeling; per-project breakdown; scope tags.
**Reject:** write-immediately edits; permanent delete; minimal frontmatter parser.

---

## Adjacent, not direct competitors

- **lasoons/AgentSkillsManager** (VS Code extension, v0.6.0, 98 stars, pushed 2026-01-17 - stale): manages skills for the *active IDE's* workspace skills directory (VSCode/Cursor/Trae/Antigravity/Qoder/Windsurf/CodeBuddy), repository-based install + cloud catalog search (~58K skills from claude-plugins.dev). It is per-IDE-scoped, not a fleet manager: near-peer, not a direct competitor to a five-location fleet instrument. **Adjacent value:** the "add a skill repo, browse, check, install" interaction is the simplest install-loop evidence in the set.
- **Distribution registries and harnesses (separated per ticket; not product-investigated):** skills.sh (referenced by five+ competitor READMEs as the shared skill marketplace/leaderboard - multi-source corroboration that it is the de-facto registry), ClawHub (OpenClaw registry used by SkillDeck/skilldock/jiweiyeah for install/publish), MCP.Directory (referenced by skilldock for MCP install), Smithery (referenced by HarnessKit for MCP), SkillsMP (referenced by xingkongliang as an AI-search layer over skills.sh). agentskill.sh, Skill MarketPlace, SwarmSkills, AgentX, OmniDev: named in the ticket as adjacent; **no first-party evidence was gathered for these in this pass** - labeled not-evidenced, and they are registries/harnesses, not management UIs, so they sit outside the direct-competitive set by definition.

## Comparison matrix

| Product | Form | Runtimes | Source of truth | Security scan | Preview/diff | Rollback | Provenance | Maturity (stars / version) |
|---|---|---|---|---|---|---|---|---|
| xingkongliang/skills-manager | Tauri desktop + CLI | 52 | central `~/.skills-manager` library + git backup | none evidenced | update guard (held-back-removals); no pre-write diff | git snapshots, undoable conflict choices | device/repo history; per-skill merge | 3,799 / v1.34.2 |
| jiweiyeah/Skills-Manager | Tauri desktop | 30+ | central location + symlink sync | publish preflight; MIT-0 explicit consent | none (live symlinks) | none evidenced | publish records (slug+version) | 939 / v2.1.8 |
| luongnv89/asm | npm CLI + TUI | 19 | installed dirs + optional local library | **pre-install shell/network/credential scan; frontmatter validation; commit pinning** | audit surfaces | re-link/dup handling | registry commit pins | 870 / v2.15.0 |
| crossoverJie/SkillDeck | macOS Swift GUI | 12 | per-agent dirs + lock file | none evidenced | update-check status | lock file | lock file | 535 / v0.0.26 |
| wanghuan9/skilldock | Tauri desktop | ~35 | managed library `~/.skilldock/skills` + git sources | none evidenced (signed releases) | **staged/unstaged/incoming diffs + hunk revert** | hunk/file revert | upstream git source + who-updated | 446 / v1.0.11 |
| RealZST/HarnessKit | Tauri desktop | 12 x 5 ext types | agent dirs + tracked sources | **18 rules, trust tiers, per-agent re-audit, permission dims** | transport-aware install gating | none evidenced | per-extension origin tracking | 396 / v1.8.2 |
| knoxgraeme/skillfish | npm CLI | 33 | installed dirs + `skillfish.json` manifest | none evidenced | `install --dry-run` | protected manual installs | pinned refs in manifest | 306 / v1.0.31 |
| tddworks/SkillsManager | macOS Swift GUI | 2 | installed + catalogs | none evidenced | live preview (editor) | uninstall/unlink | none | 162 / - |
| mode-io/skill-manager | local web/desktop + Python | 6 | shared inventory | **LLM-backed scan (config-dependent)** | review-first posture | none evidenced | none evidenced | 114 / v0.3.1 |
| abubakarsiddik31/skill-manager | Tauri desktop | 11 | agent dirs | none evidenced | none | reversible `.disabled/` toggle | none | 9 / v0.3.1 |

## Borrow / reject synthesis for Skill Manager

**Borrow (with evidence):**
1. **Managed/unmanaged/enabled vocabulary** (skilldock) + **scope tags user/project** (abubakarsiddik31) as the row-level state grammar; map onto Skill Manager's OK/MIRROR/DRIFT.
2. **Staged/unstaged/incoming diff + hunk revert** (skilldock) - the closest competitor analog to Skill Manager's preview/confirm; adopt the diff vocabulary and per-hunk control in the redesign.
3. **Security posture as a visible tiered surface** (HarnessKit trust tiers + per-agent re-audit + five permission dimensions; asm's shell/network/credential scan dimensions) - keep Skill Manager's documented/inferred/unknown evidence labels, add a content-scan surface and present findings as attention items.
4. **"Needs review" as a named first-class state** (mode-io) - corroborates the Attention surface.
5. **Preset-as-one-time-deploy** (xingkongliang) and **manifest with pinned refs + protected manual installs** (skillfish) - both fit Skill Manager's explicit-change model.
6. **Explicit-consent gates** (jiweiyeah MIT-0 publish consent) and **block-don't-invent install gating** (HarnessKit transport-aware grey-out) - match Skill Manager's typed-acknowledgement and unknown/blocked rules.
7. **Per-agent reading-priority tables** (SkillDeck) as Explain content; **status persistence on detail pages** ("Up to Date").
8. **CLI/JSON parity** (asm `--json`, xingkongliang shared-core CLI) - the redesign should keep API-first data so a CLI can stay in lockstep.

**Reject (with evidence):**
1. **Always-live symlink sync** (jiweiyeah) - violates preview/confirm and verified-apply.
2. **Auto background push/merge** (xingkongliang auto-sync) - Skill Manager's change model is explicit; auto-sync erases the evidence boundary.
3. **Central local library replacing the repo-canonical anchor** (xingkongliang, skilldock, jiweiyeah) - Skill Manager's canonical repo + `skillmgr.yaml` provenance is the differentiator; mirror-library designs lose audit + origin evidence.
4. **Heuristic trust scores presented as authority** (HarnessKit) - keep evidence levels.
5. **Auto-remove audits** (asm `audit --yes`) - surface, never silently remove.
6. **macOS-only delivery** (SkillDeck, tddworks) and **marketplace-publishing as core scope** (jiweiyeah ClawHub) - out of contract.

**Positioning takeaway:** the market has converged on "library + deploy + enable/disable + update-check," with security scanning entering as a differentiator and only skilldock approaching Skill Manager's diff/preview discipline. Skill Manager's defensible wedge is *evidence-backed management*: canonical origin provenance (append-only, verified), honest per-agent evidence levels, preview-before-write with verified apply and rollback, and drift-with-reason states - none of the ten competitors ship that combination.

## Gaps and no-evidence labels

- **Screenshots** referenced in competitor READMEs were not visually verified this pass (no vision pass run); UI claims rest on each product's own README text/captions (interested-party evidence) - flagged above.
- **Runtime verification:** no competitor was installed and run; "works" claims come from READMEs/CHANGELOGs, not observation. Where a behavior is only claimed by the vendor (e.g. HarnessKit's 18 rules, asm's security scan), it is labeled vendor-claimed.
- **skills.sh / ClawHub / MCP.Directory / Smithery / SkillsMP** are evidenced only through competitor README references (multi-source for skills.sh); their internals are not verified.
- **agentskill.sh, Skill MarketPlace, SwarmSkills, AgentX, OmniDev** - named by the ticket as adjacent; no first-party evidence gathered - not-evidenced, excluded from the direct set by definition.
- Release/star counts are GitHub API snapshots as of 2026-08-17 and will drift.

## Source appendix

All retrieved 2026-08-17. Trust class: Codebase/runtime for cloned source reads; Web (first-party GitHub) for API metadata.

**Direct competitors (repos cloned at HEAD):**
- xingkongliang/skills-manager: https://github.com/xingkongliang/skills-manager (README, CHANGELOG) - site https://skillsmanager.dev
- jiweiyeah/Skills-Manager: https://github.com/jiweiyeah/Skills-Manager (README, DESIGN.md, SECURITY.md, PRIVACY.md) - site https://skillsmanager.freeourdays.com
- luongnv89/asm: https://github.com/luongnv89/asm (README, RELEASE_NOTES, CHANGELOG, SECURITY.md, prd.md) - catalog https://luongnv.com/asm/
- crossoverJie/SkillDeck: https://github.com/crossoverJie/SkillDeck (README, README_CN, docs/DEVELOPMENT.md)
- wanghuan9/skilldock: https://github.com/wanghuan9/skilldock (README, README.zh-CN, docs/) - releases https://github.com/wanghuan9/skilldock/releases (v1.0.11, signed)
- RealZST/HarnessKit: https://github.com/RealZST/HarnessKit (README, README.zh-CN, release notes v1.8.2) - releases https://github.com/RealZST/HarnessKit/releases
- knoxgraeme/skillfish: https://github.com/knoxgraeme/skillfish (README) - registry https://skill.fish
- tddworks/SkillsManager: https://github.com/tddworks/SkillsManager (README, docs/ARCHITECTURE.md, prototype)
- mode-io/skill-manager: https://github.com/mode-io/skill-manager (README, README.zh-CN) - releases https://github.com/mode-io/skill-manager/releases
- abubakarsiddik31/skill-manager (supplied): https://github.com/abubakarsiddik31/skill-manager - full profile in the #13 companion note; releases https://github.com/abubakarsiddik31/skill-manager/releases

**Adjacent:**
- lasoons/AgentSkillsManager: https://github.com/lasoons/AgentSkillsManager (README) - catalog https://claude-plugins.dev/
- skills.sh registry: referenced by xingkongliang, SkillDeck, skilldock, HarnessKit, skillfish READMEs (multi-source): https://skills.sh
- ClawHub: referenced by SkillDeck, skilldock, jiweiyeah (publish flow): https://clawhub.ai (link per README references)
- MCP.Directory (skilldock README), Smithery (HarnessKit README): https://mcp.directory, https://smithery.ai

**GitHub API metadata (2026-08-17 snapshot):** repo/release endpoints for all eleven repos above (stars, forks, created/pushed dates, latest release tag + date, artifact signatures).
