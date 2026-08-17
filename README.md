# Skill Manager

> **Evidence and safe change control for a multi-agent skill fleet.**
>
> Skill Manager shows which skills each agent can discover, whether installed copies agree, why a runtime sees a skill, and which changes are safe to make. It is a local evidence instrument for operators running skills across Pi, OpenCode, Claude, and a shared repository.

![Genome Wall](docs/screenshots/genome-wall.png)

A skill is a five-location genome: `pi` · `opencode` · `claude` · `shared` · `repo`. When its copies agree, the strip is continuous. When they disagree, it breaks in coral.

## Before and after

| Before | After |
| --- | --- |
| Copies drift across agents and no one notices | The Genome Wall shows every copy and flags where they disagree |
| A runtime cannot find a skill and no one knows why | Explain resolves the discovery path with stated evidence |
| Updating means guessing which copy is canonical | Every change is previewed against the repo source before confirmation |

[Get started](#quick-start) · [Onboarding guide](docs/onboarding.html) · [Releases](https://github.com/intelligentrascal/skill-manager/releases)

---

## OBSERVE

### Genome Wall

The whole fleet as a compact field of five-location genome strips. Identical copies are healthy deployment mirrors. Drift is the signal that deserves attention.

| Status | Meaning |
| --- | --- |
| `OK` | A single copy |
| `MIRROR` | Multiple identical copies |
| `DRIFT` | Copies with the same name differ |
| `VARIANT` | A metadata-backed state for a registered adaptation. The scanner does not emit variant metadata yet, so a deployed variant currently appears as drift |

The repository copy also receives a `repoClean` check against `git HEAD`.

### Matrix and List

Switch between a dense skill-by-location matrix and list rows that carry a compact genome strip. See healthy, absent, and mutated copies without losing the fleet view.

![Matrix view](docs/screenshots/matrix-view.png)

### Full-text search

Search `SKILL.md` bodies, not merely names. Find the skill that mentions a tool, workflow, or phrase and jump to the matching text.

![Full-text search](docs/screenshots/body-search.png)

### Watch

When a skill copy changes on disk, the inventory re-scans and the affected strip settles into its new state. Live updates arrive over a local event stream, with a polling fallback where the filesystem refuses watching.

![Watch ripple](docs/screenshots/watch-ripple.gif)

## EXPLAIN

### Portability

See what Pi, Claude, Codex, and OpenCode actually do with a skill's frontmatter. Findings are labeled documented or inferred, and unknown fields are surfaced rather than declared broken.

![Portability view](docs/screenshots/portability-view.png)

### Explain

Ask the useful question directly: why does agent X see skill Y? Per-agent answers resolve the discovery path, measure integrity against the repo copy, and give the honest negative case - with confidence stated where precedence is not documented.

![Explain tray](docs/screenshots/explain-tray.png)

### Provenance

Every skill knows where it came from. A committed `skillmgr.yaml` records provenance (upstream / mine / promoted / upstream-edited), the canonical upstream URL and subpath, and a pinned revision. Frontmatter is only a suggested import - the manifest is the authority.

### Canonical origins

A skill without a managed canonical copy can be assigned one of three honest origins - verified public GitHub, private/community, or mine/local - with the origin evidence and an append-only history recorded in `skillmgr.yaml`. Public GitHub origins validate the repository and exact `SKILL.md` subpath, then pin a revision; private origins reject credential-bearing URLs and require an attribution note. The import previews the selected copy and its hash before creating the canonical baseline, then commits and pushes canonical content plus provenance. A rejected push leaves the verified local commit inspectable for safe retry. Private and local origins never present GitHub stars, owner facts, or pinned revisions.

Selecting a skill opens an origin-led evidence workspace instead of a drawer. Public GitHub facts are served from a local cache and refresh only when the user chooses **Refresh GitHub facts**; opening a skill never polls GitHub. The variant column always shows Pi, Claude, OpenCode, and Codex with an honest Canonical, Variant stored, Deployed, Verified, or Unknown state. Registered snapshots include their canonical diff, base revision, and active agent-profile evidence; missing records stay Unknown rather than being treated as failed adaptations. Tablet and mobile use a stacked full-screen workspace with persistent Back navigation.

## CHANGE SAFELY

### Review queue

Drifted skills and uncommitted repo copies surface in a focused queue. Inspect the change before acting - the queue never applies anything on its own.

![Mutation queue](docs/screenshots/mutation-queue.png)

### Sync preview and confirmation

Sync flows are previewed before confirmation. You see the exact source and target copies, then choose which targets to overwrite. A target is written only after its current hash still matches the preview.

![Specimen tray](docs/screenshots/specimen-tray.png)

### Manifest-pinned upstream updates

A skill that declares a pinned upstream identity in `skillmgr.yaml` (URL, subpath, and revision) can be previewed at that revision. The preview is read-only and mirror-gated: it reports whether the baseline is the repo mirror and marks apply as available only when it is. Apply and rollback exist in the update service but are not yet exposed in the dashboard - only the preview is surfaced today. When executable behavior changes, the service requires a typed acknowledgement.

### Variants with verification

A claude-only skill becomes usable on pi, opencode, or codex as a linked variant: adapted per agent (claude invocation fields removed, opencode triggers added, and anything that does not carry over is reported rather than dropped), stored as a full snapshot, and deployed explicitly. The deployed copy is then re-verified; a failure is reported, and the deployment must not be treated as accepted - it is not rolled back automatically.

### Agent variant matrix

Every skill in the workspace shows Pi, Claude, OpenCode, and Codex in a fixed order with an honest Canonical, Variant stored, Deployed, Verified, or Unknown state. A real registered variant exposes a readable canonical diff, its canonical base revision, the active agent-profile revision, and the evidence level backing it. Absent sidecars and missing snapshots stay Unknown - never a failure or an invented adaptation. Manual variant editing is not a normal flow: the workspace points to the AI-assisted Adaptation Review as the supported path.

### AI-assisted Adaptation Reviews

An upstream revision can generate an Adaptation Review: it identifies the behavior changes (frontmatter fields added/removed/modified, body changes), explains the impact for every affected agent using the active evidence-backed profiles, and proposes each affected variant with its evidence and uncertainty made visible. Reviews are cached by canonical revision plus agent-profile revision, so an unchanged pair reuses prior analysis instead of costing new model work. Unknown or unsupported mappings block apply rather than inventing an adaptation; silent metadata changes (license, author, version, tags, category) surface as uncertainty rather than blockers.

### Verified apply to the master repository

One approved Adaptation Review updates the canonical skill and its generated variants as a single managed revision: stage, deploy, verify, commit, then push directly to `agent-skills/main`. The canonical `SKILL.md`, variant sidecars, the review analysis, and `skillmgr.yaml` provenance are committed together. Deployed copies are re-read and verified before any git mutation; a deployment or verification failure restores the prior local copies and prevents a partial commit/push. A rejected push keeps the verified local commit and writes an Attention item for safe review and retry - never an automatic rebase.

## QUICK START

```bash
git clone https://github.com/intelligentrascal/skill-manager.git
cd skill-manager
npm install
npm run serve
```

Open [http://127.0.0.1:7788](http://127.0.0.1:7788). No account, cloud service, or build step.

## DISCOVERY LOCATIONS

Skill Manager scans the standard Pi, OpenCode, Claude, shared, and repository locations, parses each `SKILL.md`, hashes the full file, and groups copies by skill name.

| Location | Default path | Layout |
| --- | --- | --- |
| `pi` | `~/.pi/agent/skills` | flat |
| `opencode` | `~/.config/opencode/skills` | flat |
| `claude` | `~/.claude/skills` | flat, often symlinked |
| `shared` | `~/.agents/skills` | flat |
| `repo` | `<your-agent-skills-repo>/skills` | nested by category |

Override paths with `SM_PI_SKILLS`, `SM_OPENCODE_SKILLS`, `SM_CLAUDE_SKILLS`, `SM_SHARED_SKILLS`, and `SM_REPO_SKILLS`. Set `SM_PORT` to change the default port, `7788`.

## SAFETY MODEL

- **Preview before confirmation.** Sync is previewed and requires explicit target confirmation before any copy is written. Upstream update preview is available through the API; no update apply is exposed through the dashboard.
- **The repo is the source of truth.** Drift resolution starts from the repository copy, which is reviewable before a target changes.
- **Manifest-pinned identity.** Upstream updates follow the identity pinned in `skillmgr.yaml` (URL, subpath, and revision). Nothing guesses from HEAD.
- **Variant verification.** A deployed variant is re-checked against the copy the target reads. Failures are reported - a failing deployment is not removed and must not be treated as accepted.
- **Verified apply transactions.** Apply runs stage, deploy, verify, commit, push in strict order. Deployment or verification failure rolls back local copies; a rejected push retains the local commit and creates an Attention item for review - never a rebase.
- **Local-only binding.** The dashboard runs on `127.0.0.1` using Node built-ins only. There is no hosted backend, account, or cloud service; GitHub is contacted on demand only for upstream checks and update previews.

## LIMITS

- **Runtime facts are labeled, not guessed.** Each compatibility and discovery finding is documented, inferred, or unknown. Pi and Claude profiles are documented; Codex and OpenCode profiles are inferred until runtime probes verify them.
- **No absent repo mirror is represented as apply-capable.** The update preview marks apply as available only when the baseline is the repo mirror; an installed copy is never presented as the mirror.
- **Adaptation reviews are bounded by evidence.** Unknown or unsupported mappings block apply rather than being invented. Unverified runtime probes are labeled inferred or unknown, never documented.
- **No universal compatibility claim.** Skill Manager reports what it can prove and labels the rest. It does not claim that every frontmatter field works in every runtime.

## LINKS

- [Onboarding guide](docs/onboarding.html)
- [Latest releases](https://github.com/intelligentrascal/skill-manager/releases)
- [Build specification](BUILD-SPEC.md)

## LICENSE

MIT
