# Skill Manager - Build Spec (core logic + server)

You are building the core of a local skills-management app. The project is at
<repo-root> (already scaffolded: package.json,
tsconfig.json, src/scanner.ts stub). Work ONLY inside this project. TypeScript, no
external dependencies (Node built-ins only). Node runs TS directly via
`node --experimental-strip-types` - so use plain ESM TypeScript WITHOUT decorators,
and use explicit `.ts` extensions on relative imports.

## What the app does

The user has AI-agent skills (SKILL.md files) installed in several locations across
their machine, for different agent harnesses (Pi, OpenCode, Claude, shared). The app
scans all locations, builds an inventory, and reports: which skills exist, which
harness/agent exposes each, what each does (frontmatter description), and whether
copies are duplicated, drifted, or out of date.

## Files to produce

### 1. src/config.ts

Export a SCAN_LOCATIONS array:

```ts
{ name: "pi",        root: "~/.pi/agent/skills" }
{ name: "opencode",  root: "~/.config/opencode/skills" }
{ name: "claude",    root: "~/.claude/skills" }
{ name: "shared",    root: "~/.agents/skills" }
{ name: "repo",      root: "~/agent-skills/skills", nested: true }
```

`nested: true` means skills live at <root>/<category>/<name>/SKILL.md (the repo layout);
otherwise <root>/<name>/SKILL.md. Also export PORT = 7788.

### 2. src/scanner.ts (replace the stub)

Functions:

- `walkForSkills(root, nested): SkillFile[]` - walk (max depth 4 for nested, 3 otherwise,
  skip node_modules/.git/backup dirs) and find every SKILL.md; return { dir, name: dirname, path, root, nested }.
- `parseFrontmatter(text): Record<string, unknown>` - parse the YAML frontmatter block
  between leading `---` lines (simple line-based YAML: `key: value`; handle quoted values;
  ignore complex nested YAML but keep the raw block).
- `hashFile(path): string` - sha256 hex of file bytes.
- `scanAll(): Inventory` - the full inventory:
  - For each location, find skills; for each skill read SKILL.md, parse frontmatter,
    compute sha256 of the SKILL.md content, stat mtime.
  - Each SkillRecord: { name, location, harnesses: string[] (which locations expose a
    copy of this name - e.g. if pi + shared + repo all have `hallmark`, harnesses = [pi, shared, repo]... actually per-copy: harnesses = [location names] that have this name),
    description, tags, model, license, version, sha, path, mtimeISO, nested }
  - `byName: Record<name, SkillRecord[]>` - all copies grouped by skill name.
  - For each name: compute status:
    - `unique` = one copy
    - `duplicate` = multiple copies with identical sha
    - `drift` = multiple copies with different sha (the copies disagree)
    - For repo copies: `repoClean` = the on-disk SKILL.md matches git HEAD
      (run `git -C <repoRoot> show HEAD:<relpath>` and compare sha; repoRoot =
      ~/agent-skills; relpath = skills/<category>/<name>/SKILL.md)
    - Summary stats: total skills (unique names), total copies, per-location counts,
      counts of duplicate/drift/unique names, oldest/newest mtime.
  - Return { generatedAt: ISO, stats, byName, locations: [{name, root, count}] }.
- Handle errors per-file (unreadable SKILL.md -> skip, note in a warnings array).

### 3. src/server.ts

A zero-dependency Node http server:

- GET / -> serve src/public/index.html (read from disk each request).
- GET /api/inventory -> run scanAll(), cache the result in a module-level variable for
  60s (re-scan after), return as JSON.
- GET /api/skill?name=<name> -> return { name, copies: [...], fullText: <concatenated SKILL.md text of the repo copy, or first copy> }.
- GET /api/refresh -> force re-scan, return inventory.
- Log requests to console. Listen on PORT (127.0.0.1).

### 4. src/public/index.html

A placeholder page (I will replace it with the real dashboard - just make it load
`/api/inventory` and dump the JSON as <pre> so the API is testable). Keep it minimal:
a <pre id="out"> and a script that fetches /api/inventory and sets textContent.

## Quality bar

- `npm run typecheck` passes (tsc --noEmit with the given tsconfig).
- `npm run scan` runs and prints a valid JSON inventory with real data.
- `npm run serve` serves the API; GET /api/inventory returns 200 JSON.
- No external npm packages. Node >= 22 built-ins only.
- Read the ACTUAL skill directories - the machine is Windows (paths use backslashes, but
  Node handles forward slashes; use path.join everywhere).

Test your work: run `npm run scan` and verify the output has real skills (e.g. names like
hallmark, agent-reach, headstart, grill-me should appear). Fix until it works.

## Compatibility engine (v1.1.0, added 2026-08-12)

Knowledge-first portability: what each agent runtime actually does with a
skill's frontmatter, grounded in documentation + the pi source, NOT heuristic
guessing.

- `src/compat.ts` - the knowledge base + pure report function.
  - `AGENT_PROFILES`: per-agent profile for pi / claude / codex / opencode.
    Each has honors / ignores / breaks / silent / requires / notes /
    confidence (`documented` | `inferred`).
  - Severity model (deliberately conservative):
    - `honors` - fields the agent acts on.
    - `ignores` - BEHAVIORAL fields silently ignored (intent lost) -> warn,
      with evidence + remediation.
    - `silent` - informational metadata (author, license...) - never flagged.
    - `requires` - fields that must be present (missing description = skill
      not loaded on pi).
    - unknown/custom fields -> surfaced as `customFields`, distinct from ok,
      but never a status change (no false authority).
  - `PROFILE_VERSION` - bump when profiles change.
- `GET /api/compat` - server endpoint. Response shape:
  - `profileVersion`, `generatedAt`
  - `skills[]`: `{ name, agents: { pi|claude|codex|opencode: { status,
    issues: [{field, severity, evidence, note, remediation}], customFields } } }`
  - `summary`: `byAgent` counts, `byIssueCode` aggregation (agent + field +
    severity + count), `anyIssue`, `skillsWithIssues`, `unknownFieldCount`
- Scanner captures every frontmatter key per copy (`fields: string[]`,
  filtered to real keys - single-word, no prose spillover).
- Verified pi semantics (2026-08-12): pi honors `allowed-tools`
  (experimental) and `disable-model-invocation` (hidden from auto-discovery,
  `/skill:name` retains access); missing `description` = skill not loaded.
- Fleet result (this machine): 258 skills, pi/codex/opencode 182 ok / 76
  warn, claude 258 ok. Top issue: `argument-hint` ignored by
  pi/codex/opencode (68 skills).
- Phase 2 (not built): runtime probes to verify `inferred` profiles
  (codex, opencode) and upgrade confidence.

## Explain engine (added 2026-08-12)

First-class "why does agent X see skill Y": per-agent discovery resolution.

- `src/discovery.ts` - shared schema + pure resolver (schema owned centrally to
  avoid contested merge hotspots).
  - Evidence = documented | inferred | unknown; Integrity = matching | drifted |
    unmanaged | unknown.
  - DiscoveryProfile { agent, runtimeVersion, evidence, checkedAt, paths[],
    precedence[], notes[] }; DiscoveryPath { path, kind: global | project |
    trusted-project | package | explicit, env?, exists?, notes? }.
  - Matching is by RESOLVED PATH PREFIX (normalized separators), never by
    location name - pi scans ~/.pi/agent/skills and ~/.agents/skills, not
    ~/.claude/skills.
  - reasonCode is the stable API contract (found-global | found-project |
    found-trusted-project | found-package | found-explicit | not-found |
    blocked-* | unknown-no-profile); verdict prose is UI-side.
  - Integrity measured against the repo source (matching/drifted); unmanaged
    when no repo copy exists.
- `src/discoveryProfiles.ts` - per-agent facts. Pi facts contributed by the
  pi-side review, validated against Pi 0.84.1 docs/skills.md (global +
  trusted-project + package + explicit sources, precedence, --no-skills and
  collision semantics). Claude documented; codex/opencode inferred (honest).
- `GET /api/explain?name=X` - filesystem probe (exists flags on discovery
  paths), resolution per agent, plus the compat report for the skill.
- Windows specifics: HOME can be git-bash style (/c/...) - prefer USERPROFILE
  on win32; normalize backslashes before prefix matching.
- Suggestions: each compat issue carries suggestions[] (action, risk:
  low/medium/high, whyMayAlter) - advisory only, "remove field" flagged where
  it would change the authoring agent's behavior. No auto-apply.

## A+B+C tracks (added 2026-08-12, collaborative build)

Three parallel tracks, divided by agent strength and cross-reviewed:

- **A - provenance manifest** (wR:p1): `src/manifest.ts` - skillmgr.yaml schema
  (Provenance, SkillIdentity with upstreamUrl/subpath/pinnedRevision,
  SkillVariant, SecurityReview), strict validation (version check, enum
  validation, unknown-key rejection), `parseManifest` + `readManifestSync`.
  Scanner integration: records get provenance from the manifest.
  `GET /api/manifest`.
- **B - update-from-upstream** (design-review): `src/update.ts` contract +
  `src/updates.ts` implementation - `GitUpstreamUpdateService` (shallow clone
  at pinned revision, snapshotDirectory, computeDiff with behaviorSignals,
  assessSecurityGate with typed acknowledgement, staged apply + rollback).
  `GET /api/update` is manifest-gated (honest 404 without a pinned identity).
- **C - variant creation** (main): `src/variant.ts` pure adaptation rules
  (per-agent: pi keeps allowed-tools + disable-model-invocation, opencode adds
  triggers, claude-invocation fields dropped + guidance folded into a note,
  carry-over honesty) + `src/variantStore.ts` (sidecar store under
  .skillmgr/variants, deployVariant, verifyDeployedVariant, removeVariant).
  `POST /api/variant` + `POST /api/variant/deploy`.
- Verification loop (spec 4b): deployed variants are re-checked - removed
  fields must be gone; a failure is reported, not automatically rolled back.
- Performance: batch git status (one call vs 223 spawns) - cold load
  13.9s -> 0.57s.

## Canonical origin capture (ticket #2, added 2026-08-16)

Evidence-backed origin assignment for skills without a managed canonical copy,
plus the import that promotes a discovered copy into `agent-skills` and commits
- pushes it. This is the backend vertical slice only - the origin-led workspace
UI is ticket #4 and is deliberately not built here.

- `src/origin.ts` - the pure origin model + validation. Three assignable types
  (`github` | `private` | `local`) plus an honest `unknown` state.
  - `parseGithubUrl` accepts only clean https github.com repo URLs and returns
    owner/repo + a canonical clone URL.
  - `containsCredentials` rejects userinfo and token/invite query params.
  - `validateOriginInput` enforces the per-type contract: github validates repo
    - exact `SKILL.md` subpath (revision is pinned by the import service);
    private requires an attribution note and rejects credential-bearing URLs;
    local allows at most an ownership note and never claims an external source.
  - `reassignOrigin` is append-only: the current origin moves into history.
  - `summarizeOrigin` is the API honesty boundary: identity (a GitHub fact) is
    returned only for a github origin; private/local/unknown never fabricate
    owner/repo/pinned-revision data.
- `src/import.ts` - `OriginImportService`: preview (read-only, content hash),
  assign (re-verify approved hash, write canonical content + manifest, verify,
  commit, push). A rejected push is reported with the commit SHA and left on
  the branch for inspection/retry - never auto-rebased or reset. A conflicting
  existing canonical copy is never silently overwritten.
- `src/manifest.ts` - `origin` field on each skill record (`current` + append-
  only `history`), a relaxed identity requirement for private origins
  (explicitly unverified, no pinned revision), and `serializeSkillEntry` /
  `upsertSkillEntry` / `newManifestWithEntry` for minimal-diff YAML writes.
- Server: `GET /api/origin?name=` (current state), `POST /api/origin/preview`
  (read-only), `POST /api/origin/assign` (import + commit + push).

Provenance mapping: github and private both record `provenance: upstream` (a
verified or community upstream); local records `provenance: mine`. Only a
verified github origin carries an `identity` (URL + subpath + pinned revision).

## Agent evidence registry (ticket #3, added 2026-08-16)

Versioned, evidence-backed capability profiles + an approval-gated monthly
proposal workflow. This is the ticket's vertical slice only - not adaptation
variants (#5/#6/#7) or the origin-led workspace (#4).

- `src/evidenceRegistry.ts` - schema (schemaVersion 1, registryVersion x.y.z),
  strict validation, and the seed registry. Each profile records sources
  (official URL + verbatim excerpt + content hash + observedAt/version),
  behavior claims (honors/ignores/breaks/requires/silent, each with an evidence
  level), and adaptation constraints. Pi and Claude are documented; codex and
  opencode are inferred with no fetchable source (blocked, never guessed).
- `src/evidenceSchedule.ts` - pure first-Friday-10:00-local math + a re-arming
  scheduler.
- `src/evidenceCheck.ts` - the official-source check: fetch fetchable sources,
  hash-compare, and produce a pending proposal (changed/unchanged/unreachable/
  no-baseline/blocked). Pure; `fetchFn` is injectable for tests.
- `src/evidenceStore.ts` - active registry + Attention proposal persistence
  under `.skillmgr/` in the agent-skills repo (`SM_EVIDENCE_REGISTRY_ROOT`
  override).
- `src/evidenceApprove.ts` - the approval gate (the ONLY path that mutates the
  active registry): re-baselines changed sources, bumps the version, then git
  commit + push to origin with the source evidence. A failed push leaves the
  local commit for retry.

Endpoints: `GET /api/evidence-registry`, `POST /api/evidence-registry/check`,
`POST /api/evidence-registry/approve`. The scheduled and on-demand checks never
activate a revision - only an explicit approve does (AC3).

## Origin-led skill workspace (ticket #4, added 2026-08-16)

Selecting a skill opens a provenance-led detail workspace in place of the middle
inventory area. Desktop keeps the Fleet/Genome rail with a 60/40 two-column
workspace; tablet and mobile switch to a full-screen stacked view with sticky
Back navigation.

- `src/githubOriginMetadata.ts` - `GithubOriginMetadataCache` (persisted under
  `SM_CACHE_DIR`) + `createGithubRepositoryReader` (explicit network adapter).
  Page reads serve only cached, validated facts; GitHub is contacted only via
  `POST /api/origin/refresh`. Responses are validated against the pinned
  repository identity (owner, repo, URL, avatar host allow-list) before caching.
- Server: `GET /api/origin?name=` serves cached GitHub facts (null for
  private/local/unknown), `POST /api/origin/refresh` re-verifies a public
  origin and persists the result. Private/local/unknown never fabricate GitHub
  identity or metadata; unknown origin makes Assign origin the primary action.
- The workspace honors the five reviewed Mobbin reference directions (dark
  Genome surfaces, provenance hero, evidence details, right-side agent variant
  matrix) and was validated at desktop, tablet, and mobile widths.

## Agent variant matrix (ticket #5, added 2026-08-16)

- `src/variantMatrix.ts` - `buildAgentVariantMatrix` produces honest rows for
  Pi, Claude, OpenCode, Codex with Canonical | Variant stored | Deployed |
  Verified | Unknown states.
  - A registered sidecar snapshot exposes a readable canonical diff (LCS-based,
    `readableDifference`), the canonical base revision, agent-profile revision,
    evidence level, observed runtime version, and evidence basis.
  - Verified requires: deployed bytes match the snapshot, profile evidence is
    not unknown, `verifyDeployedVariant` passes against current adaptation
    constraints, the canonical base is current, and the runtime discovery
    winner matches the snapshot path. Anything less is honestly Deployed,
    Variant stored, or Unknown - never a failure.
  - Unregistered sidecars are ignored (not invented into variants).
- Server: `GET /api/variant-matrix?name=` (workspace endpoint). No manual
  variant-edit controls; the UI names AI-assisted Adaptation Review as the
  supported next stage.

## AI-assisted Adaptation Reviews (ticket #6, added 2026-08-16)

- `src/diff.ts` - shared `readableDifference` used by both the variant matrix
  and reviews.
- `src/adaptationReview.ts` - pure `generateAdaptationReview` over
  (skill, baselineRevision, upstreamRevision, baselineContent, upstreamContent,
  registry). Produces a change summary (frontmatter fields added/removed/
  modified, body-change flag, line counts) and per-agent proposals for all four
  agents using the active evidence-backed profiles. Each proposal carries
  evidence (level, observed version, basis), uncertainty notes, and blocking
  conditions. Unknown or unsupported mappings block apply; silent metadata
  fields (license, author, version, tags, category) add uncertainty only.
- `src/reviewCache.ts` - cache keyed by canonical revision + agent-profile
  revision, so unchanged pairs reuse prior analysis with zero model work.
- Server: `POST /api/adaptation-review/generate` (+ cached reads). The verified
  apply transaction is ticket #7 and is deliberately not built here.

## Verified apply to the master repository (ticket #7, added 2026-08-16)

- `src/apply.ts` - `VerifiedApplyService` with an injectable git boundary for
  testability. Strict order: STAGE (canonical SKILL.md + variant sidecars +
  provenance manifest + analysis JSON written via `WriteTracker`) -> DEPLOY
  (copy to each target agent discovery path) -> VERIFY (re-read deployed copy,
  byte match + `verifyAdaptation` removed-field check) -> COMMIT (canonical,
  variants, analysis, provenance together) -> PUSH
  (`git push origin HEAD:refs/heads/main`).
  - Failure before a confirmed push: `WriteTracker.restoreAll()` restores every
    prior local copy (targets and staged working tree) and no commit/push
    occurs (AC3).
  - Rejected push: the verified local commit is retained (`retryable`), an
    Attention item is written under `.skillmgr/attention/apply/`, and no rebase
    or amend is ever attempted (AC4).
- Server: `POST /api/adaptation-review/apply` wires the service to the
  `agent-skills` repo root with per-agent target paths.
