# Fleet Browse Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard browse-first without weakening the existing evidence and safe-change controls, and rewrite the README as an adoption document.

**Architecture:** Keep all server APIs and mutation behavior unchanged. Add an app-mode state in the existing dependency-free dashboard that controls Fleet, Browse, and Attention presentation while reusing the existing Wall, Matrix, List, filters, search, tray, and action callbacks. Add a Node test that locks the markup contract, then update the README to match implemented behavior.

**Tech Stack:** Node 22 built-ins, TypeScript strip-types test runner, static HTML/CSS/JavaScript, Markdown.

---

### Task 1: Lock the new dashboard and README contract

**Goal:** Add a fast static regression test that describes the browse-first navigation shell and public README promises before implementation.

**Files:**
- Create: `test/presentation.test.ts`
- Test: `test/presentation.test.ts`

**Acceptance Criteria:**
- [x] The test requires `Fleet`, `Browse`, and `Attention` buttons and an `appMode` state in `src/public/index.html`.
- [x] The test requires the existing `genome-wall`, `matrix`, `rows`, and `health` surfaces to remain present.
- [x] The test requires a README quick start and a safety-model section, and rejects the machine-specific `258 skills` headline.

**Verify:** `npm test -- test/presentation.test.ts` first fails because the new UI markers and README section do not exist, then passes after Tasks 2 and 3.

**Steps:**

- [x] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync("src/public/index.html", "utf8");
const readme = readFileSync("README.md", "utf8");

test("dashboard exposes fleet browse and attention without removing existing evidence surfaces", () => {
  for (const marker of [
    'data-app-mode="fleet"',
    'id="fleetModeBtn"',
    'id="browseModeBtn"',
    'id="attentionModeBtn"',
    "let appMode = \"fleet\"",
    'id="genomeWall"',
    'id="matrix"',
    'id="rows"',
    'id="healthItems"',
  ]) assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("README leads with product outcome, quick start, and safety model", () => {
  assert.match(readme, /## QUICK START/);
  assert.match(readme, /## SAFETY MODEL/);
  assert.doesNotMatch(readme, /\*\*258 skills/);
});
```

- [x] **Step 2: Run the focused test and confirm the expected red failure**

Run: `npm test -- test/presentation.test.ts`

Expected: failure because Fleet/Browse/Attention markers and the Safety Model README section are absent.

- [x] **Step 3: Do not change production code in this task**

The test stays red until the following tasks add the product contract.

- [x] **Step 4: Commit the red test only after it is demonstrably red**

```bash
git add test/presentation.test.ts
git commit -m "test: define fleet browse shell contract"
```

### Task 2: Implement Fleet, Browse, and Attention app modes

**Goal:** Add a material information-architecture layer to the static dashboard while retaining all existing API operations and detail views.

**Files:**
- Modify: `src/public/index.html: root dashboard markup, dashboard CSS, app-mode JavaScript state, renderHealthActions`
- Test: `test/presentation.test.ts`

**Acceptance Criteria:**
- [x] Fleet is the initial mode and shows fleet stats, the Genome Wall, and attention only when actionable items exist.
- [x] Browse defaults to List and retains search, filters, List, Matrix, Wall, and Portability controls.
- [x] Attention isolates the health queue and provides a truthful empty message when no actions are present.
- [x] Mode buttons maintain `aria-pressed`, have keyboard focus styles, and work without a server API change.
- [x] Existing tray, Explain, sync preview/confirmation, upstream checks, snapshot export, watch refresh, and theme behavior still work.

**Verify:** `npm test -- test/presentation.test.ts`, `npm test`, `npm run typecheck`, then serve the app and inspect `/api/inventory` plus the browser page.

**Steps:**

- [x] **Step 1: Add the browse shell markup**

Wrap the dashboard surfaces in a `main.workspace-shell`. Add an `aside.mode-rail` before the content with three buttons:

```html
<button id="fleetModeBtn" class="mode-btn" type="button" aria-pressed="true">Fleet</button>
<button id="browseModeBtn" class="mode-btn" type="button" aria-pressed="false">Browse</button>
<button id="attentionModeBtn" class="mode-btn" type="button" aria-pressed="false">Attention <span id="attentionCount">0</span></button>
```

Set the root dashboard wrapper to `data-app-mode="fleet"`. Keep the existing `#stats`, `#healthItems`, `#genomeWall`, `#matrix`, `#portabilityMatrix`, `#rows`, and drawer IDs unchanged.

- [x] **Step 2: Add structural CSS, not a cosmetic recolor**

Add `.workspace-shell` as a two-column grid with a narrow sticky rail. Add responsive rules that convert the rail to a horizontal row under 860px. Use `data-app-mode` selectors to:

```css
.wrap[data-app-mode="browse"] .health { display: none; }
.wrap[data-app-mode="attention"] .stats,
.wrap[data-app-mode="attention"] .controls,
.wrap[data-app-mode="attention"] .content-surface,
.wrap[data-app-mode="attention"] #foot { display: none; }
```

Add a compact Genome strip to list rows using the existing five `HARNESSES` locations and existing `gene` classes. Do not add filesystem paths to visible copy.

- [x] **Step 3: Add app-mode state and event wiring**

Near the existing view state, define:

```js
let appMode = "fleet";

function setAppMode(nextMode) {
  appMode = nextMode;
  document.querySelector(".wrap").dataset.appMode = nextMode;
  for (const [mode, id] of Object.entries({
    fleet: "fleetModeBtn",
    browse: "browseModeBtn",
    attention: "attentionModeBtn",
  })) document.getElementById(id).setAttribute("aria-pressed", String(mode === nextMode));
  if (nextMode === "fleet") setView("genome");
  if (nextMode === "browse") setView("list");
  renderHealthActions();
}
```

Wire each button to `setAppMode`. Do not change `setView` API behavior.

- [x] **Step 4: Make the attention queue conditional and truthful**

In `renderHealthActions`, set `#attentionCount` to `ACTIONS.length`. In Fleet mode, hide `.health` when the queue is empty. In Attention mode, keep the section shown and append a non-clickable `No actions need review.` message when no actions exist. Continue opening a skill through the existing `openSkill` handler.

- [x] **Step 5: Add compact Genome strips to List rows**

Use the same `HARNESSES.map(location => copies.find(...))` lookup as `renderGenomeRow`. Add a `span.list-track` containing five `span.gene` children after the list row's status badge. Reuse `present`, `variant`, `drift`, and pulse classes where available.

- [x] **Step 6: Run focused and full checks**

Run:

```bash
npm test -- test/presentation.test.ts
npm test
npm run typecheck
git diff --check
```

Expected: all tests pass, TypeScript passes, and no whitespace errors.

- [x] **Step 7: Commit implementation**

```bash
git add src/public/index.html test/presentation.test.ts
git commit -m "feat: add fleet browse attention shell"
```

### Task 3: Rewrite the README for adoption and safety

**Goal:** Present Skill Manager as an evidence-first product, with screenshots and truthful limitations before implementation details.

**Files:**
- Modify: `README.md`
- Test: `test/presentation.test.ts`

**Acceptance Criteria:**
- [x] README starts with a product outcome, not local machine totals.
- [x] README uses the existing Genome Wall screenshot and has Observe, Explain, and Change safely sections.
- [x] README includes quick start, scan locations, safety model, and limitations.
- [x] No claim implies that unavailable repo mirrors can be updated or that compatibility is universally known.

**Verify:** `npm test -- test/presentation.test.ts`, `git diff --check`, and inspect rendered Markdown on GitHub or a Markdown preview.

**Steps:**

- [x] **Step 1: Replace the headline and opening block**

Use:

```md
> **Evidence and safe change control for a multi-agent skill fleet.**
>
> Skill Manager shows which skills each agent can discover, whether copies agree, why a runtime sees a skill, and which changes are safe to make.
```

Retain the real Genome Wall image immediately below it.

- [x] **Step 2: Add a short before/after comparison and three feature groups**

Create `## OBSERVE`, `## EXPLAIN`, and `## CHANGE SAFELY` sections. Place Genome Wall, Matrix, search, and watch under Observe; portability, Explain, and provenance under Explain; sync preview, upstream review, variants, security acknowledgement, and rollback under Change safely.

- [x] **Step 3: Retain quick start and define clear safety constraints**

Add `## SAFETY MODEL` with preview-before-confirmation, repo source-of-truth, manifest-pinned upstream identity, variant verification, and local-only operation. Add `## LIMITS` stating that discovery/compatibility facts can be documented, inferred, or unknown, and no absent repository mirror is represented as apply-capable.

- [x] **Step 4: Run the README contract test and formatting check**

Run:

```bash
npm test -- test/presentation.test.ts
git diff --check
```

Expected: the contract test passes and diff check emits no output.

- [x] **Step 5: Commit documentation**

```bash
git add README.md test/presentation.test.ts
git commit -m "docs: position skill manager for fleet operations"
```

### Task 4: Verify the running product and publish the branch

**Goal:** Verify UI behavior and API honesty end to end, then send the reviewed branch to GitHub.

**Files:**
- Modify only if verification exposes a defect: `src/public/index.html`, `README.md`, `test/presentation.test.ts`

**Acceptance Criteria:**
- [x] `/api/inventory` returns data and the dashboard renders without browser-console errors.
- [x] Fleet, Browse, and Attention all work using real inventory data.
- [x] No API action behavior changed or became less safe.
- [x] Full tests, typecheck, and diff check pass from a clean worktree.

**Verify:** `npm test`, `npm run typecheck`, `git diff --check`, live `/api/inventory`, and a browser smoke test.

**Steps:**

- [x] **Step 1: Start the server**

```bash
npm run serve > /tmp/skill-manager-server.log 2>&1 &
server_pid=$!
```

- [x] **Step 2: Check the real inventory API and dashboard document**

```bash
curl --fail http://127.0.0.1:7788/api/inventory > /tmp/skill-manager-inventory.json
curl --fail http://127.0.0.1:7788/ > /tmp/skill-manager.html
node -e "const d=require('/tmp/skill-manager-inventory.json'); if (!d.stats || !d.byName) process.exit(1); console.log(Object.keys(d.byName).length)"
```

Expected: HTTP 200 responses and a nonzero skill count.

- [x] **Step 3: Run browser smoke test**

Open `http://127.0.0.1:7788`, activate Fleet, Browse, and Attention, search for an existing skill, open its tray, then confirm no console errors and that the sync action still asks for confirmation before a write.

- [x] **Step 4: Run final automated checks**

```bash
npm test
npm run typecheck
git diff --check
git status --short
```

Expected: tests and typecheck pass, diff check is empty, and only intended tracked changes are present before the commit.

- [ ] **Step 5: Commit any verification fix and push**

```bash
git push -u origin feat/fleet-browse-shell
```
