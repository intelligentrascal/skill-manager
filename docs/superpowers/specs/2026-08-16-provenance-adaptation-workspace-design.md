# Provenance, Adaptation, and Skill Workspace Design

**Status:** approved direction, pending implementation-plan review  
**Date:** 2026-08-16

## Purpose

Skill Manager manages one canonical skill source, its evidence-backed origins, and AI-generated agent variants. A user must be able to answer three questions from one skill workspace:

1. Where did this skill come from?
2. What differs for each target coding agent, and why?
3. What will change locally and in the private master repository if an upstream revision is approved?

The master skills repository is `intelligentrascal/agent-skills`, a private repository. It is the canonical Git-backed source for managed skills and generated variants.

## Product rules

### Canonical origin

Every managed skill has exactly one current origin state:

- **Verified GitHub:** canonical repository URL, exact `SKILL.md` subpath, pinned revision, verified owner/repository facts, and a cached GitHub metadata timestamp.
- **Private/community:** optional private URL without credentials or invite tokens, required attribution note, and an explicit unverified state. The UI must not invent GitHub stars, owner facts, or upstream freshness.
- **Mine/local:** a user-owned canonical source with optional ownership note and no claimed external upstream.
- **Unknown:** no origin is known. The skill is not eligible for upstream updates; Assign origin is the primary action.

An origin change is append-only. The current origin is prominent while prior origins retain timestamp, reason, and attribution history.

Assigning an origin to a skill without a canonical repository copy imports a selected discovered copy into `agent-skills` as the initial canonical skill. The import preview includes the selected copy and content hash before commit.

### Git mirroring

After a user approves an upstream update, variant generation, provenance assignment, or approved agent-profile update, Skill Manager commits and pushes directly to `agent-skills/main`. Generated variants live under the existing sidecar shape:

```text
.skillmgr/variants/<skill>/<agent>/SKILL.md
```

Installed runtime copies are deployment targets, never canonical sources and never committed as source-of-truth artifacts.

A rejected push never triggers automatic rebase or conflict resolution. The verified local commit remains available for review/retry and is surfaced in Attention.

### AI adaptation

Variants are reproducible AI-assisted adaptations of canonical skills, not manually maintained forks.

An upstream revision creates an **Adaptation Review** that contains:

- upstream change summary and source revision;
- per-agent impact analysis;
- proposed variant content and readable diffs;
- source evidence from the active agent profile;
- explicit uncertainty or blocking conditions.

The adapter preserves the semantic instruction content of a skill. It may only adjust behavior using the active evidence-backed agent profile. Unsupported mappings block apply instead of guessing.

Adaptation output is cached by the pair `(canonical revision, agent-profile revision)`. If neither input changed, the app reuses the prior analysis and variant without invoking a model.

### Agent evidence registry

The private master repository stores versioned capability profiles for Pi, Claude, OpenCode, and Codex. Each profile records official source URLs, source evidence, observation date/version, supported behavior, and adaptation constraints.

A scheduled job runs on the first Friday of every month at 10:00 local time. It fetches official documentation, compares it with the active registry, and creates a reviewable proposal in Attention. It never activates a changed profile automatically. Once approved, the profile revision is committed and pushed to `agent-skills/main` and becomes eligible for future Adaptation Reviews.

### Verified apply transaction

One approved Adaptation Review performs this sequence:

1. Stage canonical content and all affected generated variants.
2. Deploy staged variants to discovered agent targets.
3. Verify deployed content and required adaptation invariants.
4. Commit canonical files, variants, adaptation analysis, and provenance to `agent-skills/main`.
5. Push the commit directly to GitHub.

A deployment or verification failure restores prior local copies and prevents commit/push. A GitHub push failure preserves the verified local commit and creates an Attention item for safe retry.

## Skill workspace

### Desktop

Selecting a skill replaces the dashboard's middle inventory area with an immersive detail workspace. The Fleet/Genome rail remains visible for orientation and Back returns to the prior filtered inventory state.

The workspace has three visual zones:

1. **Genome rail:** persistent navigation and app context.
2. **Primary column, approximately 60%:** origin hero, canonical skill evidence, upstream change analysis, compatibility, and safe actions.
3. **Variant column, approximately 40%:** the agent-variant matrix and per-agent difference summaries.

The origin hero is the first element in the primary column. For a verified GitHub origin it shows:

- owner identity and avatar when verified;
- repository name and outbound link;
- cached star count;
- pinned revision and exact `SKILL.md` subpath;
- verification status and last-verification timestamp.

GitHub metadata refresh occurs only through an explicit refresh action or the existing upstream-check workflow. Page load does not fan out requests across the inventory.

### Variant matrix

The variant column always lists Pi, Claude, OpenCode, and Codex. Every row uses one honest state:

- Canonical
- Variant stored
- Deployed
- Verified
- Proposed
- Evidence needed
- Unknown

Existing variants show a readable summary of differences and the evidence/revision behind them. The interface does not make manual variant editing a normal operation. The primary action is Review adaptation when a candidate exists.

### Responsive behavior

At tablet width, the primary and variant areas stack within the middle workspace while retaining the app rail.

At mobile width, the skill workspace becomes a full-screen stacked detail view with a persistent Back control. It does not squeeze into a side drawer. Private, local, and unknown origin states remain visually distinct at every width.

## Visual direction

**Direction:** evidence-led technical workspace. It uses Skill Manager's existing near-black Genome surfaces, amber for active evidence and primary action, coral for risk, and monospace detail labels. The memorable move is a provenance identity card that makes a skill's origin as immediately legible as its name.

It intentionally avoids a generic settings pane, a floating drawer, repeated card grids, or the light palettes of the references.

### Tokens

```css
:root {
  --bg: #0b0e12;
  --surface: #12171d;
  --surface-raised: #19212a;
  --ink: #f0f3f5;
  --muted: #91a0ad;
  --line: #2b3540;
  --amber: #e8b44a;
  --coral: #e26d5a;
  --green: #6cc78f;
  --blue: #7eb6e8;
  --unit: 8px;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 18px;
  --font-detail: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --font-body: Inter, ui-sans-serif, system-ui, sans-serif;
}
```

Motion is limited to a short workspace transition on open/Back and a status change highlight after an approved transaction. It must respect reduced-motion preferences.

### Reviewed references

- [GitHub activity](https://mobbin.com/api/mcp/short/5dQGpW07): dense, chronological evidence records.
- [Linear project detail](https://mobbin.com/api/mcp/short/CcTFSz6W): persistent property rail beside an editable primary record.
- [Graphite activity panel](https://mobbin.com/api/mcp/short/IDIRDgIH): focused contextual activity hierarchy.
- [GitLab repository page](https://mobbin.com/api/mcp/short/CHJsDa8M): repository facts and project-information rail.
- [Vercel Git settings](https://mobbin.com/api/mcp/short/K6Nb0ZHE): explicit connected-repository card and transparent operational toggles.

These references inform hierarchy, density, and connection treatment only. The existing Skill Manager palette and Genome language remain fixed brand constraints.

## Error behavior

- Public-origin validation failure leaves existing provenance unchanged and explains the failed repository, subpath, or pin check.
- Private-origin validation rejects credentials and invite tokens before persistence.
- Missing GitHub metadata displays the known origin without a star count and says when data was last available.
- Missing agent profile evidence blocks adaptation rather than manufacturing a variant.
- All recovery paths name the failed transaction stage and retain enough evidence to retry safely.

## Verification

- Unit coverage validates provenance types, append-only origin history, cache keys, profile activation boundaries, transaction rollback, and push-rejection recovery.
- API coverage proves private and unknown origins never return fabricated GitHub fields.
- Browser coverage verifies desktop, tablet, and mobile workspace layouts; keyboard Back navigation; reduced-motion behavior; and readable variant states.
- Integration coverage validates stage, deploy, verify, commit, and push order against isolated repositories and temporary deployment targets.

## Delivery sequence

The approved GitHub tickets are the execution plan:

1. #2 Canonical origin capture and import
2. #3 Agent evidence registry and monthly review
3. #4 Origin-led responsive skill workspace
4. #5 Agent variant matrix
5. #6 AI Adaptation Review
6. #7 Verified apply and Git mirroring
