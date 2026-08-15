# Fleet Browse Shell Design

## Decision

Skill Manager will remain a local-first Node dashboard. It will not adopt Tauri, React, direct folder deletion, or direct overwrite editing. The dashboard will gain a distinct browse-oriented shell that makes the fleet understandable before it asks the user to diagnose changes.

## Audience and job

The audience is an operator who has skills installed across multiple agent runtimes and a repository mirror. The dashboard's single job is to answer, in order:

1. What is in my fleet?
2. Which skills are healthy or need attention?
3. Which runtime or project context should I inspect?
4. Why does a runtime see a skill, and what safe action is available?

## Product structure

The current server API and safety flows remain the authority. The frontend adds presentation-level navigation modes:

- **Fleet** is the default. It shows concise fleet statistics, the health queue only when attention exists, and the Genome Wall.
- **Browse** is a dense, searchable inventory. It is optimized for finding a skill by name, behavior, or status, not for diagnosing every mutation immediately.
- **Attention** contains the mutation queue. It is visibly separate from normal browsing and never implies that healthy mirrors need cleanup.

The existing Wall, Matrix, List, search, specimen tray, Explain, portability, provenance, upstream preview, variants, sync preview, and watch behavior remain reachable and unchanged.

## Visual direction

The product remains an evidence instrument rather than a generic dark SaaS application:

- Keep the dark charcoal ground, amber control color, coral mutation signal, monospace operational details, and five-location Genome strips.
- Make a skill's location strip the signature visual artifact. Browser rows use the same compact strip, preserving the fleet visual language outside Wall mode.
- Use plain words for user-facing navigation: Fleet, Browse, Attention, Wall, Matrix, List. Do not expose local filesystem paths in surface copy.
- Support light mode with semantic tokens and keyboard focus. Motion stays restrained and respects reduced-motion preferences.

## README

The README becomes an adoption document rather than an implementation inventory:

1. Promise and a real Genome Wall image.
2. A short before/after comparison.
3. Observe, Explain, and Change safely feature sections.
4. Quick start, supported scan locations, safety model, and limits.
5. Build specification and implementation details last.

It must not use machine-specific fleet totals as product claims. It must only claim safety and compatibility behavior currently implemented.

## Safety boundaries

This change introduces no mutation endpoint and does not change API semantics. Existing confirmation requirements for sync and existing provenance, security-gate, and rollback contracts remain unchanged. UI labels must not make upstream apply seem available when the API reports it is unavailable.

## Acceptance criteria

- The default UI presents Fleet before diagnostic detail and exposes Browse and Attention as first-class modes.
- Users can enter List or Matrix through Browse without losing search, filters, Wall, tray, Explain, sync, or theme behavior.
- The Genome strip appears as a shared visual primitive in both Wall and Browse rows.
- The health queue is not rendered in Fleet when there are no actionable items.
- README presents the product outcome, real screenshots, quick start, safety model, and limitations without machine-specific headline statistics.
- Existing test suite and TypeScript checks pass, and live inventory/API smoke testing has no browser-console errors.
