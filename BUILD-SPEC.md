# Skill Manager - Build Spec (core logic + server)

You are building the core of a local skills-management app. The project is at
C:\Users\Rahil\Documents\9. Projects\skill-manager (already scaffolded: package.json,
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
{ name: "pi",        root: "C:/Users/Rahil/.pi/agent/skills" }
{ name: "opencode",  root: "C:/Users/Rahil/.config/opencode/skills" }
{ name: "claude",    root: "C:/Users/Rahil/.claude/skills" }
{ name: "shared",    root: "C:/Users/Rahil/.agents/skills" }
{ name: "repo",      root: "C:/Users/Rahil/Documents/9. Projects/agent-skills/skills", nested: true }
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
      C:/Users/Rahil/Documents/9. Projects/agent-skills; relpath = skills/<category>/<name>/SKILL.md)
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
