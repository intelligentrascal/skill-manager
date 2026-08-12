# Skill Manager

**Know what skills your agents have, where they live, and whether they drifted.**

Skill Manager is a local-first dashboard for the skills spread across your AI
coding agents. It scans every skill directory on your machine - Pi, OpenCode,
Claude, shared, and your source repo - parses each `SKILL.md`, and tells you:

- **What's installed** - every skill, its description, tags, model, and license
- **Where it lives** - which harnesses expose a copy (Pi, OpenCode, Claude, shared, repo)
- **If it's healthy** - are there duplicates? Have copies **drifted** apart?
  Is the repo copy out of sync with git?
- **What it actually does** - the full `SKILL.md` is one click away

Zero dependencies. Node built-ins only. Runs entirely on your machine.

![Skill Manager](https://artifacts.aarr.dev/sm-dashboard.png)

## Why

AI agents are only as good as their skills - but skills rot silently. Copies
drift between harnesses (a fix lands in `~/.agents` but not the repo), the same
skill name hides two different versions, and nobody can answer "is my skill set
up to date?" without spelunking five directories by hand.

Skill Manager makes the inventory visible, the drift detectable, and the "what
does this actually do" question answerable in one click.

## Quick start

```bash
git clone https://github.com/intelligentrascal/skill-manager.git
cd skill-manager
npm install
npm run serve          # starts on http://127.0.0.1:7788
```

Open the URL. That's it.

## Features

- **Full inventory** - scans 5 locations, parses frontmatter, builds one view
- **Status model** per skill name:
  - `OK` - a single copy, or multiple identical copies
  - `DUP` - multiple copies with identical content (consistent, just installed everywhere)
  - `DRIFT` - copies disagree (same name, different content - the dangerous one)
- **`repoClean`** - for repo skills: does the on-disk copy match git HEAD?
- **Search + filters** - search by name/description, filter by harness (Pi /
  OpenCode / Claude / shared / repo) and by status (OK / DUP / DRIFT)
- **Detail drawer** - every copy (location, sha, mtime), the description, tags,
  and the full `SKILL.md` text
- **Re-scan on demand** - plus a 60s cache so the dashboard stays snappy
- **Dark / light theme** - persisted

## What gets scanned

| Location | Default path | Layout |
| --- | --- | --- |
| pi | `~/.pi/agent/skills` | flat (`<name>/SKILL.md`) |
| opencode | `~/.config/opencode/skills` | flat |
| claude | `~/.claude/skills` | flat (often symlinks) |
| shared | `~/.agents/skills` | flat (harness-agnostic) |
| repo | `~/Documents/9. Projects/agent-skills/skills` | nested (`<category>/<name>/SKILL.md`) |

All paths are overridable via environment variables (see below), so the app
works on any machine layout.

## The status model, explained

Skills get installed by many mechanisms - link farms, copies, manual installs.
The same skill name can exist in several places with the *same* or *different*
content. Skill Manager computes, per skill name:

```
sha256 of each copy's SKILL.md
  one copy                 -> OK (unique)
  multiple, same sha       -> DUP (duplicate - consistent, harmless)
  multiple, different sha  -> DRIFT (the copies disagree - needs attention)
```

`DRIFT` is the signal that matters: it means a fix or update landed in one
location but not others, and you're running two different versions of the same
skill depending on which agent you ask.

For skills in the `repo` location, `repoClean` additionally checks the on-disk
file against `git HEAD` - so an uncommitted edit or a stale checkout is visible
too.

## Configuration

```bash
SM_PI_SKILLS=~/.pi/agent/skills
SM_OPENCODE_SKILLS=~/.config/opencode/skills
SM_CLAUDE_SKILLS=~/.claude/skills
SM_SHARED_SKILLS=~/.agents/skills
SM_REPO_SKILLS=~/.../skills      # nested category layout
SM_PORT=7788
```

Unset variables fall back to the defaults above.

## Architecture

```
src/
  config.ts    scan locations + port (env-overridable)
  scanner.ts   discovery, frontmatter parsing, sha, status + repoClean
  server.ts    zero-dep HTTP server: /api/inventory, /api/skill, /api/refresh
  public/
    index.html the dashboard (single file, no build step)
```

- Scanner: walks each location (max depth 4), finds `SKILL.md`, parses the YAML
  frontmatter, sha256s the content, groups by name, computes status.
- Server: Node `http` only. Serves the dashboard + three JSON endpoints.
- Dashboard: vanilla JS, DOM-based rendering (no innerHTML), dark/light theme.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /` | the dashboard |
| `GET /api/inventory` | full inventory (cached 60s) |
| `GET /api/skill?name=X` | copies + description + full `SKILL.md` |
| `GET /api/refresh` | force re-scan, returns inventory |

## Roadmap

- [ ] GitHub upstream check for third-party skills (is there a newer version?)
- [ ] Export a static snapshot (HTML) for sharing
- [ ] Suggested actions: sync the drifted copy, clean duplicates
- [ ] Watch mode: live re-scan on file changes

## License

MIT
