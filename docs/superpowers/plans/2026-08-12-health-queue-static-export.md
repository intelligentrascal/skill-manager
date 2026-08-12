# Health Queue and Static Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make detected skill-health problems actionable without mutating local files, and let operators download a safe portable inventory snapshot.

**Architecture:** Add two pure TypeScript modules: one derives health recommendations from inventory records, and one renders a fully escaped standalone snapshot. The HTTP server exposes them and the single-page UI renders a health queue and download control.

**Tech Stack:** Node 26 built-ins, TypeScript strip-types execution, Node test runner, vanilla DOM APIs.

---

## Tasks

### Task 1: Add testable health recommendations

**Goal:** Derive only meaningful, read-only attention items from inventory data.

**Files:**

- Create: `test/health.test.ts`
- Create: `src/health.ts`
- Modify: `package.json`

**Acceptance Criteria:**

- [ ] Drift creates a high-priority item naming the conflicting locations.
- [ ] A repo copy where `git status` reports a changed file creates a medium-priority item.
- [ ] Identical duplicate copies create no recommendation.

**Verify:** `npm test` prints three passing health tests.

**Steps:**

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildHealthActions } from "../src/health.ts";

test("prioritizes drift over healthy duplication", () => {
  const actions = buildHealthActions({ byName: {
    alpha: [{ location: "pi", sha: "one" }, { location: "shared", sha: "two" }],
    beta: [{ location: "pi", sha: "same" }, { location: "shared", sha: "same" }],
  }});
  assert.deepEqual(actions.map((action) => action.skill), ["alpha"]);
  assert.equal(actions[0].priority, "high");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL because `src/health.ts` does not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
export function buildHealthActions(inventory: { byName: Record<string, Array<{ location: string; sha: string; repoClean?: boolean }>> }) {
  // Return deterministic action objects for drift and dirty repo copies.
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json test/health.test.ts src/health.ts
git commit -m "feat: add health action recommendations"
```

### Task 2: Add an escaped static snapshot generator

**Goal:** Generate a standalone report that can be safely shared outside the local app.

**Files:**

- Create: `test/snapshot.test.ts`
- Create: `src/snapshot.ts`

**Acceptance Criteria:**

- [ ] Snapshot is complete HTML with inline styles and no external asset URLs.
- [ ] It includes current counts and skill rows.
- [ ] Interpolated names and descriptions are escaped.

**Verify:** `npm test` prints snapshot test passes.

**Steps:**

- [ ] **Step 1: Write the failing test**

```ts
test("escapes inventory content in the static snapshot", () => {
  const html = renderSnapshot({ generatedAt: "2026-08-12T00:00:00.000Z", stats: { totalSkills: 1, totalCopies: 1, drift: 0, duplicate: 0, unique: 1 }, byName: { "<skill>": [{ location: "pi", sha: "x", description: "<script>" }] } });
  assert.match(html, /&lt;skill&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL because `src/snapshot.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
export function renderSnapshot(inventory: SnapshotInventory): string {
  // Escape dynamic text and return one self-contained HTML document.
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/snapshot.test.ts src/snapshot.ts
git commit -m "feat: add safe static inventory snapshots"
```

### Task 3: Expose and render both workflows

**Goal:** Connect the two pure modules to the local API and dashboard.

**Files:**

- Modify: `src/server.ts`
- Modify: `src/public/index.html`
- Modify: `README.md`

**Acceptance Criteria:**

- [ ] `GET /api/actions` returns current actions as JSON.
- [ ] `GET /api/snapshot` returns a downloadable HTML attachment.
- [ ] The UI lists action items and downloads the snapshot using the new control.
- [ ] The README documents both features and endpoints.

**Verify:** `npm run typecheck && npm test`, then start with `SM_PORT=7799 npm run serve` and assert 200 responses for `/`, `/api/actions`, and `/api/snapshot`.

**Steps:**

- [ ] **Step 1: Extend server endpoints**

```ts
if (req.method === "GET" && url.pathname === "/api/actions") {
  return sendJson(res, buildHealthActions(getInventory()));
}
if (req.method === "GET" && url.pathname === "/api/snapshot") {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": "attachment; filename=skill-manager-snapshot.html" });
  res.end(renderSnapshot(getInventory()));
  return;
}
```

- [ ] **Step 2: Add dashboard controls and queue**

```js
async function downloadSnapshot() {
  const response = await fetch("/api/snapshot");
  const blob = await response.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "skill-manager-snapshot.html";
  link.click();
  URL.revokeObjectURL(link.href);
}
```

- [ ] **Step 3: Update README and run integration verification**

Run: `npm run typecheck && npm test`
Expected: no diagnostics and all tests pass.

- [ ] **Step 4: Commit**

```bash
git add README.md src/server.ts src/public/index.html
git commit -m "feat: surface health queue and snapshot export"
```
