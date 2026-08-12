# Health Queue and Static Export Design

## Context

Skill Manager already reveals inventory, copies, drift, repo cleanliness, and an on-demand upstream comparison. The review found no GitHub backlog, automation, releases, or tests. The next product gap is not more raw information. It is helping an operator decide what deserves attention and letting them share a safe point-in-time result.

## Options considered

1. **Automated sync and cleanup** - powerful but unsafe. A local inventory app should not overwrite skill copies or delete files without a carefully designed confirmation and rollback model.
2. **Read-only health queue plus static export** - turns detected health signals into a prioritized, non-destructive workflow and makes an inventory shareable. Recommended.
3. **Filesystem watch mode** - convenient but adds platform-specific watcher behavior and only saves one click. It is less valuable than explaining what requires action.

## Chosen design

### Feature 1: Health queue

A pure health evaluator derives a small set of read-only recommendations from the scanned inventory:

- **Drift** is high priority. It names the conflicting locations and opens the existing detail drawer where the operator can inspect the line diff.
- **Repo copy changed from git HEAD** is medium priority. It highlights the exact copy that `git status` reports as modified and should be reviewed or committed.
- Healthy duplicates do not produce an action because duplicate installation is explicitly harmless in the existing status model.

`GET /api/actions` returns the recommendations for API users. The dashboard renders a compact health queue above the inventory list. Each recommendation is keyboard reachable and opens its skill detail. The queue never writes, synchronizes, or deletes a skill.

### Feature 2: Static snapshot export

`GET /api/snapshot` returns a downloadable, standalone HTML report made from the current inventory. It contains the timestamp, aggregate health counts, and a table of skill names, status, harnesses, and descriptions. It intentionally excludes full skill text and absolute local paths. User home directories in descriptions are not special-cased because descriptions are content owned by the user, but all text is HTML-escaped.

The existing UI gets an **Export snapshot** control that downloads the report without navigating away. The snapshot uses inline CSS and no external dependencies, so it works when emailed or attached to an issue.

## Boundaries and error handling

- Both capabilities reuse the current 60-second inventory cache.
- Failed export serialization returns a JSON 500 error rather than a partial download.
- The health evaluator accepts only the minimal inventory shape it needs, keeping it deterministic and unit-testable.
- The snapshot generator escapes interpolated data and derives its own display status from copies, preventing an injected description or skill name from becoming executable HTML.

## Tests

- Health evaluator tests verify drift is prioritized, dirty repo copies are identified, and identical duplicates create no unnecessary action.
- Snapshot tests verify an export is standalone, includes representative inventory data, and escapes HTML-looking names and descriptions.
- Existing typecheck, scanner, and isolated HTTP smoke checks cover integration.
