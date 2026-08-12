# SKILL MANAGER

> **The skill genome for your agent fleet.**
>
> A local-first dashboard that makes every installed skill visible: where it lives, what each agent sees, and where its copies have mutated.

**258 skills · 707 installed copies · five discovery locations · zero runtime dependencies**

A skill is a five-location genome: `pi` · `opencode` · `claude` · `shared` · `repo`.
When its copies agree, the strip is continuous. When they disagree, it breaks in coral.

[Get started](#quick-start) · [Onboarding guide](docs/onboarding.html) · [Releases](https://github.com/intelligentrascal/skill-manager/releases)

---

## THE GENOME WALL

The whole fleet as a compact field of five-location genome strips. Identical copies are healthy deployment mirrors. Drift is the signal that deserves attention.

![Genome Wall](docs/screenshots/genome-wall.png)

## FEATURES

### Mutation queue
A focused queue for drifted skills, uncommitted repo copies, and upstream checks. Inspect the change before acting.

![Mutation queue](docs/screenshots/mutation-queue.png)

### Specimen tray
Open any skill to inspect its copies, hashes, metadata, and exact line diff. The repo copy is the source of truth; sync flows are previewed before confirmation.

![Specimen tray](docs/screenshots/specimen-tray.png)

### Matrix view
Switch from the visual wall to a dense skill-by-location matrix. See healthy, absent, and mutated copies without losing the fleet view.

![Matrix view](docs/screenshots/matrix-view.png)

### Full-text search
Search `SKILL.md` bodies, not merely names. Find the skill that mentions a tool, workflow, or phrase and jump to the matching text.

![Full-text search](docs/screenshots/body-search.png)

### Watch mode
When a skill copy changes, the affected genome ripples, the inventory re-scans, and the strip settles into its new state.

![Watch ripple](docs/screenshots/watch-ripple.gif)

### Portability
See what Pi, Claude, Codex, and OpenCode actually do with a skill's frontmatter. Compatibility findings carry evidence and confidence, not guesswork.

![Portability view](docs/screenshots/portability-view.png)

### Explain
Ask the useful question directly: why does agent X see skill Y? Per-agent answers identify discovery paths, integrity, and the honest negative case - with confidence stated where precedence is not documented.

![Explain tray](docs/screenshots/explain-tray.png)

### Provenance

Every skill knows where it came from. A committed `skillmgr.yaml` records provenance (upstream / mine / promoted / upstream-edited), the canonical upstream URL + subpath, and pinned revisions. Frontmatter is only a suggested import - the manifest is the authority.

### Upstream updates

Third-party skills track their ORIGINAL sources, not just your repo. Preview a full-directory diff at a pinned revision, pass the security gate (typed acknowledgement when executables change), and apply with rollback. Never HEAD-guessing, never silent.

### Variants

A claude-only skill becomes usable on pi / opencode / codex as a linked variant: adapted per-agent (invocation fields dropped, guidance folded into the description, opencode triggers added), stored as full snapshots, deployed explicitly, and verified before it stays. Variants are linked - never drift, never duplicates.

## QUICK START

```bash
git clone https://github.com/intelligentrascal/skill-manager.git
cd skill-manager
npm install
npm run serve
```

Open [http://127.0.0.1:7788](http://127.0.0.1:7788). No account, cloud service, or build step.

## HOW IT WORKS

```text
skill directories
      ↓ scan SKILL.md, metadata, hashes, mtimes
local inventory
      ↓ group copies by name and content
Genome Wall · Matrix · search · mutation queue
      ↓ apply documented runtime facts
Portability · Explain
      ↓ provenance from skillmgr.yaml
Upstream updates · Variants · adaptation
```

Skill Manager scans the standard Pi, OpenCode, Claude, shared, and repository locations. It parses each `SKILL.md`, hashes the full file, and groups copies by skill name:

| Status | Meaning |
| --- | --- |
| `OK` | One copy, or multiple identical copies |
| `MIRROR` | Identical copies installed where agents expect to find them (healthy by design) |
| `DRIFT` | Copies with the same name differ UNINTENTIONALLY and need inspection |
| `VARIANT` | A registered adaptation for one agent - linked to the skill, never flagged |

The repository copy also receives a `repoClean` check against `git HEAD`.

## KNOWLEDGE-FIRST BY DESIGN

Skill Manager is an inventory and evidence tool, not an authority simulator.

- **Physical copies are intentional.** Agents discover skills from their own paths. Exact duplicates are shown as healthy mirrors, not as waste to delete.
- **The repo is the source of truth.** Drift resolution starts from the repository copy and is reviewable before a target is changed.
- **Compatibility is conservative.** Documented facts and inferred behavior are labeled separately. Unknown frontmatter is surfaced, not falsely declared broken.
- **Discovery is explicit.** Explain reports why an agent sees a skill, or why it does not, using resolved paths and stated evidence.
- **Everything stays local.** The dashboard runs on `127.0.0.1` using Node built-ins only.

## DISCOVERY LOCATIONS

| Location | Default path | Layout |
| --- | --- | --- |
| `pi` | `~/.pi/agent/skills` | flat |
| `opencode` | `~/.config/opencode/skills` | flat |
| `claude` | `~/.claude/skills` | flat, often symlinked |
| `shared` | `~/.agents/skills` | flat |
| `repo` | `<your-agent-skills-repo>/skills` | nested by category |

Override paths with `SM_PI_SKILLS`, `SM_OPENCODE_SKILLS`, `SM_CLAUDE_SKILLS`, `SM_SHARED_SKILLS`, and `SM_REPO_SKILLS`. Set `SM_PORT` to change the default port, `7788`.

## LINKS

- [Onboarding guide](docs/onboarding.html)
- [Latest releases](https://github.com/intelligentrascal/skill-manager/releases)
- [Build specification](BUILD-SPEC.md)

## LICENSE

MIT
