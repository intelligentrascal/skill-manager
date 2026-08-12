# Upstream-aware sync model - spec v0.2 (revised after review)

Status: revised. Reviewers challenged v0.1 on identity, fetch granularity,
variant storage, rebase semantics, and the security gate. This revision
incorporates both agents' decisions.

## 1. Provenance model (expanded from v0.1)

Every skill has a provenance state - not just two values:

| state | meaning | source of truth |
| --- | --- | --- |
| `upstream` | 3rd-party skill, managed mirror | the upstream revision |
| `upstream-edited` | upstream skill with local edits (conflict) | neither - requires decision |
| `mine` | skill originated in my repo | my repo |
| `promoted` | upstream skill deliberately adopted as mine | my repo (after explicit promotion) |

Decisions:

- D1 (identity): a skill's stable identity is its canonical upstream URL +
  subpath + pinned revision - NOT its display name. Names change; the source
  doesn't. Current upstream.ts guesses candidate paths from the name and reads
  HEAD - that is insufficient for safe updates and must be replaced with a
  pinned revision model.
- D2 (edits to upstream mirrors): editing an `upstream` skill's repo mirror is
  a CONFLICT by default. The only clean paths: revert, or explicit "promote
  local changes to variant" which records the upstream base revision and moves
  the skill to `upstream` + variant.
- D3 (promotion): "adopt as mine" is an explicit action (pins the upstream
  revision as base, detaches from future upstream updates). A skill can move
  upstream -> mine once; the reverse (mine -> upstream) requires a new
  upstream source.

## 2. Management metadata lives OUTSIDE the skills

- A committed, versioned management-side manifest in my repo (e.g.
  `skillmgr.yaml` at the repo root or under `.skillmgr/`), NOT frontmatter
  pollution (spec section 27 principle).
- Manifest records per skill: provenance state, canonical upstream URL +
  subpath, pinned revision, variant base revisions, security review state.
- Frontmatter `source:` extraction is only a SUGGESTED import on first scan -
  never authority.
- Renames/moves of skills are resolved against the manifest (identity is the
  upstream URL + subpath, so renames don't lose provenance).

## 3. Update flow (staged, reviewable - never blind)

1. Check upstream (existing read-only SHA compare, upgraded to pinned-revision
   compare against the manifest, not HEAD)
2. STALE -> per-skill "Update from upstream":
   - fetch the FULL upstream skill directory (not a guessed SKILL.md) as a
     snapshot
   - preview: full directory diff (added/removed/changed files, SKILL.md,
     scripts, references)
   - SECURITY gate: if the update adds or changes executable behavior (new
     scripts, network calls, credential references, setup steps) ->
     block unattended/batch propagation; per-skill human review with the full
     diff + explicit acknowledgement required
   - apply: write the repo mirror FIRST (atomic: stage -> verify -> swap,
     with rollback), then propagation to local copies is an explicit,
     pre-selected second step
3. Variant handling on update: variants are rebased onto the new base
   revision; conflicts (upstream changed a section the variant modified) are
   FLAGGED, never auto-merged. V1: durable conflict state + manual resolution;
   no three-way merge algorithm.
4. Batch: a staged, reviewable update queue (the approval queue). Items with
   conflicts, inferred compatibility, security triggers, or variants needing
   rebase require individual review; only clean items can batch.

## 4. Variants (full snapshots in V1, not patches)

- Storage: full variant directories in a manager-owned sidecar store OUTSIDE
  discovery roots (e.g. `.skillmgr/variants/<skill>/<agent>/`), deployed
  explicitly to the chosen agent path. V1 = full snapshots; patches/overlays
  only after real demand (spec review: patches are brittle).
- Deployment: an agent variant is deployed to ONE explicit discovery location.
  Caution: `~/.agents/skills` (shared) is read by pi AND opencode - a variant
  deployed there affects both; deployment must state the target path and the
  agents that read it.
- Creation: "Create pi variant" from the compat suggestion (drop claude
  invocation fields, fold intent into description). GATE: blocked when the
  compat finding is `inferred` (codex/opencode profiles) unless the user
  explicitly accepts inferred adaptation; `documented` findings (pi, claude)
  can proceed.
- Rebase: each variant keeps its base revision; update rebase = flag
  conflicts, never auto-merge (D-rebase).

### 4a. Per-agent adaptation rules (claude-only -> pi / opencode / codex)

Adaptation is NOT "make it identical everywhere" - it is "make it usable and
honest on the target" (native semantics over fake portability). The rules are
driven by the same knowledge base as the compat engine (documented vs
inferred):

| target | what changes | evidence |
| --- | --- | --- |
| pi | drop claude invocation fields (argument-hint, user-invocable, arguments, context); ensure a pi-discoverable description (required, reasonable length); fold invocation guidance into the description/body; keep allowed-tools + disable-model-invocation (pi honors both) | documented |
| opencode | same field drops; optionally add opencode-style triggers to the frontmatter (opencode honors triggers); description must be discoverable | inferred |
| codex | same field drops; no codex-specific conventions known yet - the variant is the stripped-down core skill | inferred |

Rules that always apply:

- The variant starts from the upstream content, applies the target's
  adaptation rules, and is stored as a FULL snapshot in the sidecar store.
- What does NOT adapt (flagged, never silently dropped): nested skills,
  allowed-tool restrictions with no target equivalent, scripts the target
  cannot execute, MCP references - shown as a "does not carry over" list in
  the variant preview.
- The variant's description is checked for discovery quality on the target
  (length, uniqueness vs the other copies - the portability lint's routing
  checks, section 16 of the product spec).

### 4b. Verification loop (adapt -> verify -> keep)

After deploying a variant:

1. Re-run the compat engine against the variant copy - the field issues that
  triggered creation must be GONE (e.g. pi no longer warns on argument-hint
  because the variant no longer carries it).
2. Re-run discovery (explain) for the target agent - the variant is the
  winner at its deployment path.
3. Show the before/after: original compat status -> variant compat status,
  and the "does not carry over" list.
4. If verification fails (a field still warns, discovery misses), the
  variant is marked failed and NOT kept as deployed - revert to the
  pre-variant state.

A variant that passes stays as the deployed copy for that agent; upstream
updates then rebase onto it with conflict flags (never auto-merge).

### 4c. Duplicate / drift categorization with variants

The current model groups copies by NAME and flags any sha mismatch as drift.
That is wrong once variants exist: a variant DIFFERS BY DESIGN, so it must
never count as drift or as a duplicate.

Revised categories (copy role decides, the manifest is the authority):

| category | meaning | example |
| --- | --- | --- |
| `mirror` | copy that must match its source | claude/shared copies of a pi skill |
| `variant` | copy that intentionally differs, LINKED to the skill identity | pi variant of a claude-only skill |
| `drift` | mirror that differs from its source UNINTENTIONALLY | a fix landed in shared but not claude |

Rules:
- Identity = provenance + skill name (+ upstream URL for third-party). Copies
  of the same identity group together regardless of role.
- A copy is a `variant` only when the manifest declares it (variant record:
  agent, base revision, deployed path). Without a manifest record, any sha
  mismatch stays `drift` - the conservative default. Variants must be
  registered, never inferred from content.
- The genome strip shows three gene states, not two: mirror-agree (filled),
  mirror-drift (coral broken), variant (distinct marker - e.g. amber gene with
  a v marker, never coral). Variant genes are LINKED, not flagged.
- Status model: OK / MIRROR (renamed from DUP, healthy by design) / DRIFT
  (unintentional) / VARIANT (registered adaptation).
- Dedupe actions operate on MIRRORS only. Variants are never dedupe targets.
- The exact-duplicate fleet finding stays valid for mirrors: identical copies
  are healthy deployment mirrors, not waste. Variants are a separate,
  linked category.

## 5. Data model

```ts
interface SkillRecord {
  provenance: "upstream" | "upstream-edited" | "mine" | "promoted";
  identity?: { upstreamUrl: string; subpath: string; pinnedRevision: string };
  variants?: { agent: string; baseRevision: string; deployedTo: string; conflict?: boolean }[];
  securityReview?: { state: "unreviewed" | "reviewed" | "blocked"; at: string };
}
```

- scanner: provenance + identity from the manifest (frontmatter = suggestion)
- sync.ts: source resolution = provenance-aware (upstream -> mirror ->
  locations; mine -> repo -> locations)
- new: full-directory fetch, staged apply with rollback, variant rebase +
  conflict state, security gate, update queue

## 6. UI

- Specimen tray: provenance badge (UPSTREAM/MINE/PROMOTED/CONFLICT),
  pinned revision + last checked, "Update from upstream" (STALE only, with
  preview + security gate), variant list + deploy targets, "Create pi variant"
  per agent (gated on evidence), conflict flags
- Fleet: upstream check stays; STALE badges gain the action

## 7. What V1 does NOT do (explicitly)

- No three-way merge for variant rebases (conflict flags only)
- No patches/overlays (full snapshot variants)
- No auto-batch propagation when security/compat-inferred/conflict items exist
- No headless "update all"
- No marketplace/registry (out of scope, unchanged from the product spec)

## 8. Open (needs user decisions)

1. Manifest format + location: `skillmgr.yaml` at repo root vs `.skillmgr/`
   dir - confirm preference.
2. Full-directory fetch implementation: shallow git clone of the upstream
   repo at the pinned revision vs tarball download (git clone is heavier but
   gives real revision pinning + file history).
3. Security gate strictness: hard block on new executables vs warn-and-log
   with a one-click override (per-skill, remembered).
4. Update queue: does "update all STALE" run as a queued review (approval
   queue #3) or stay strictly per-skill for now?
