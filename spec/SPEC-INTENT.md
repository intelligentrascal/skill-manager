# SPEC-INTENT — Per-skill upstream freshness check and in-pane update (issue #9)

Spec-first contract for quartermaster pilot 2, task t-0002, tier T3. No
implementation here — this document and `spec/freshness-check.feature` are the
contract the coder implements against.

## Intent (the feature in 3 lines)

1. After a verified public GitHub origin is assigned, the skill pane gains a
   manual freshness check that fetches current upstream state on demand and
   reports honestly: up to date / update available / drifted / unreachable —
   never silently.
2. The same pane offers an update path that reuses the existing Adaptation
   Review (#6) → verified apply (#7) flow against the pinned upstream revision
   (or an explicit re-pin), still gated on preview + confirmation.
3. Ambiguous sync wording is replaced with labels that name the source repo
   explicitly and appear only when the action is meaningful.

## Boundaries — what this feature does NOT do

- Does NOT implement a new git-fetch mechanism. Freshness and update reuse
  `GitUpstreamUpdateService.fetchSnapshot` (upstream fetch) for pinned-revision
  content; the review and apply reuse the #6 and #7 services unchanged.
- Does NOT auto-advance the pinned revision when "update available" is
  detected. Advancing the pin is an explicit user action (re-pin); review/apply
  then runs against the new pin. Identity stays `upstreamUrl + subpath +
  pinnedRevision`, never HEAD-guessing (spec v0.2 decision D1).
- Does NOT apply automatically. Apply still requires preview + confirmation per
  the #7 safety model (stage → deploy → verify → commit → push, with rollback on
  failure and an Attention item on push rejection — never a silent rebase).
- Does NOT offer freshness or update for non-GitHub origins (private / local /
  unknown). The actions are gated on a verified public GitHub origin identity.
- Does NOT do batch "update all". This is per-skill only.
- Does NOT change the origin assignment model, the manifest schema, or the #6/#7
  service contracts.
- Does NOT treat an unreachable upstream as "up to date". Honesty is the
  contract: an unknown state is reported as such, with the error surfaced.

## Acceptance criteria → reused service mapping

| Criterion (issue #9) | Reuses | Notes |
| --- | --- | --- |
| 1. Manual freshness check (up-to-date / update-available / unreachable, never silent) | **upstream fetch** (`GitUpstreamUpdateService.fetchSnapshot`, `updates.ts`) for pinned-revision content + a HEAD resolution to detect "upstream moved" | New pane action + endpoint; the fetch primitive already exists. `checkUpstream` (frontmatter HEAD-guess) is NOT the authority for a verified origin. |
| 2. In-pane update path (review → verified apply vs pinned revision or re-pin, apply still gated) | **#6 review** (`/api/adaptation-review`, `adaptationReview.ts` + `cachedAdaptationReview`) and **#7 apply** (`/api/adaptation-review/apply`, `apply.ts` `VerifiedApplyService.apply`) | Reuses `resolveReviewInput` (baseline = repo copy, incoming = fetched pinned-revision content) so reviewed and applied content never drift. |
| 3. Clarified labels (name the source repo, show only when meaningful) | — (pure pane presentation) | Rename "Preview sync from repo" → "Preview sync from agent-skills repo copy"; sync action only on drift + repo copy; freshness/update action names the source repo. |
| 4. Tests (mocked upstream up-to-date/drift/unreachable; update wiring; label visibility) | all of the above | Follows the existing workspace-server harness (`test/workspaceServer.ts`): mock GitHub remote + bare git remotes, assert pane/API behavior. |
