# Benchmark: Five Skill-Management Interface Types

- **Ticket:** [intelligentrascal/skill-manager#13](https://github.com/intelligentrascal/skill-manager/issues/13) (child of [#11 - UX/UI wayfinder map](https://github.com/intelligentrascal/skill-manager/issues/11))
- **Date:** 2026-08-17
- **Status:** Research only. No implementation, no GitHub issue changes, no resolved-decision claim.
- **Evidence posture:** Shared evidence rule (`~/.pi/agent/skills/_shared/evidence-rule.md`) - trust classes, proximity to origin, independent corroboration, no-evidence labeling.

## Executive synthesis

Five existing tool families converge on the same operating contract Skill Manager already implements, and the strongest designs make that contract *visible as a lifecycle* rather than as isolated facts:

1. **Discovery is metadata-only, activation is on-demand.** The Agent Skills standard (Anthropic) codifies progressive disclosure - name + description at startup, full content only when activated. Skill Manager's Genome Wall already renders the fleet in one glance; the benchmark says descriptions are the discovery surface that matters, and quality guidance for them exists (agentskills.io "optimizing descriptions"). A fleet operator needs a view where *name + description + one-line evidence* is scannable before any workspace opens.
2. **Drift is a first-class visual state, with a reason.** n8n's "dirty node" (yellow border + tooltip explaining *why* output is stale) and Backstage's entity processing states (error keeps the last good version; orphan detection) both pattern-match Skill Manager's DRIFT/MIRROR/OK states. The borrow: every drift strip should explain *why* the copies disagree, not just that they do.
3. **Preview-before-write is the safety standard across every category.** chezmoi (`diff` -> `apply -v`, `-n` dry run), n8n (draft -> publish -> locked production version), GitHub Actions (approval gates for fork runs; re-runs use original privileges), Homebrew (pin/unpin, `--force` warnings), VS Code (publisher trust prompt, signature verification, version pinning). Skill Manager's existing preview/confirm, verified-apply, and rollback contracts are already ahead of most; the benchmark's contribution is *naming and sequencing* those states in the UI (draft / published / error / needs-attention like n8n's publish button states).
4. **Attention surfaces are curated queues, not raw lists.** GitHub Actions re-run (all / failed / specific job), n8n executions tab, Backstage "Unprocessed Entities", VS Code `@updates` filter - every mature tool has a *filtered* working set for "what needs me now". Skill Manager's Attention view is the right shape; benchmark data suggests it should carry the *reason* and the *action* together (e.g. "drift, reason: repo copy edited since HEAD, action: preview sync").
5. **Identity is stable and namespaced.** VS Code `publisher.extension`, Claude plugin skills `plugin-name:skill-name`, Backstage entity references. Skill Manager's canonical-origin + variant model benefits from an explicit, stable identity grammar users can read and type.

Detailed per-reference analysis follows, with verbatim quotes from primary sources, then a borrow/reject matrix mapped to Skill Manager surfaces.

## Method and evidence level

- pi-web-access MCP tools (`web_search`, `fetch_content`) were **not exposed in this session**, so primary sources were fetched directly (curl raw HTML / `raw.githubusercontent.com` / official `.md` doc endpoints) and, for the Agent Skills standard, by shallow `git clone` of the official `anthropics/skills` repository. This is **fidelity level 1 (raw bytes of primary sources)** - verbatim text, no summarization layer.
- All cited URLs were retrieved 2026-08-17 unless noted. Trust class for every source: **Web** (outside the codebase trust boundary) but drawn from **first-party official docs / official source repositories** (proximity to origin is high). Claims that rest on a single source are labeled single-source. Where a captured page did not document a dimension (notably responsive/a11y specifics), that is labeled **not evidenced in captured source** rather than guessed.
- Blocks encountered (labeled, no workaround that would degrade fidelity): `marketplace.visualstudio.com` returned HTTP 503 (bot protection); `help.openai.com` returned 403; smithery.ai's interactive grid UI was captured as rendered card text only.

---

## Category 1 - Package, extension, or plugin managers

### Deep reference: VS Code Extensions view + Marketplace

**Primary sources:** official docs page "Extension Marketplace" (code.visualstudio.com/docs/editor/extension-marketplace); VS Code extension runtime security page referenced therein. (The Marketplace item page itself was 503-blocked; details-page model below is from the official docs, labeled as such.)

**Target user:** The developer who extends an editor - browse, install, manage, update, disable, and debug extensions; plus the enterprise admin (allowed lists, private marketplaces, settings sync).

**Core mental model:** An extension is identified by `publisher.extension` (e.g. `wayou.vscode-todo-highlight`); the list and the details page are the two surfaces; state transitions are Install -> Manage gear (enable/disable/update/uninstall); marketplace is the remote catalog, the Extensions view is the local instance of it.

**Navigation and entry surface:** "Bring up the Extensions view by clicking on the Extensions icon in the Activity Bar... or the View: Extensions command (Ctrl+Shift+X)". The view is a list with a search box that accepts **query-language filters**: `@installed`, `@updates` (outdated), `@disabled`, `@enabled`, `@recommended`, `@deprecated`, `@builtin`, `@category:themes`, combinable (`@installed @category:themes`), plus `@sort:installs|rating|name|publishedDate|updateDate`. Typing `@` in the box surfaces filter suggestions (IntelliSense).

**Detail/workspace model:** Selecting an extension opens a details page with README, Feature Contributions (settings/commands/keybindings the extension adds), Changelog, Dependencies, Extension Pack membership. "An extension is uniquely identified by its publisher and extension IDs."

**Attention and action patterns:** Recommended extensions (`@recommended`) - workspace recommendations shared via `.vscode/extensions.json` (`recommendations: ["dbaeumer.vscode-eslint", ...]`), "Ignore Recommendation" to dismiss; Show Outdated Extensions (`@updates`) -> "Update All Extensions"; Extension Bisect to "isolate problematic extension behavior"; sort by install count/rating.

**Preview, confirmation, rollback, safety patterns:** "As of VS Code release 1.97, when you first install an extension from a third-party publisher, VS Code shows a dialog prompting you to confirm that you trust the extension publisher." Marketplace signs all extensions; "VS Code verifies this signature when you install an extension to check the integrity and the source of the extension package." Version pinning/rollback: "If you want to install a specific version of an extension, right-click the extension and select Install Another Version." Pre-release channels exist as a separate install choice. Auto-update is delayed (default 2 hours) and can be disabled per-extension or globally; updates only apply to enabled extensions. Disable is global or per-workspace (reversible without uninstall). Enterprise `extensions.allowed` list blocks unlisted installs.

**Responsive/accessibility cues:** Documented primarily as keyboard-first: the view is one `Ctrl+Shift+X` away, command palette prefixes (`Extensions: ...`), and CLI equivalents (`code --list-extensions`, `--install-extension`, `--uninstall-extension`). No explicit responsive/a11y statement was present in the captured page (labeled not evidenced).

**Borrow for Skill Manager:**
- A query-language search box (`@drift`, `@attention`, `@mirror`, `@origin:github`, combinable with sort) would make the Browse view a power surface without new UI chrome. The `@` filter suggestion pattern is directly reusable.
- `@updates`-style "outdated" filter = "show me skills with a newer upstream revision available" - matches the manifest-pinned upstream preview surface.
- Publisher-trust confirmation at first install = analog for "first contact with a new canonical origin" (Skill Manager already requires origin assignment; the borrow is to make *first* contact with a github origin require an explicit, labeled confirmation like VS Code's trust dialog).
- Ignore Recommendation = a "snooze/ignore drift" affordance, kept honest (Attention item rather than silent dismissal).

**Reject:**
- Auto-update with a delay. Skill Manager's model is preview-then-explicit-apply; auto-apply of upstream updates would violate the evidence contract. Keep auto-*scan* (Watch), never auto-*apply*.

### Supplement: Homebrew (official FAQ, docs.brew.sh)

**Primary source:** docs.brew.sh/FAQ (2026-08-17).

**Mental model / attention:** `brew outdated` lists "which of your installed packages (kegs) are outdated"; `brew upgrade` (all) or `brew upgrade <formula>` (one). Pin to freeze: "To stop something from being updated/upgraded: `brew pin <formula_or_cask>`" / `brew unpin`. Cleanup is automatic: "Homebrew automatically uninstalls old versions of each formula that is upgraded with `brew upgrade`, and periodically performs additional cleanup every 30 days." Destructive paths are flagged: `brew uninstall --force` - "Be careful as this is a destructive operation." Single-version rollback is deliberately *not* automatic (old versions are pruned), which is a documented tradeoff.

**Borrow:** the pin/unpin primitive as a per-skill "hold this revision" control (map: pin = ignore upstream updates until unpinned, shown in the workspace as a pinned state); "outdated" as a curated list verb.

**Reject:** automatic pruning of old versions - Skill Manager keeps snapshots and verified-apply history as evidence; pruning them would destroy the audit trail.

---

## Category 2 - Prompt, skill, or agent registries

### Deep reference: Anthropic Agent Skills ecosystem (Claude Code docs + agentskills.io standard + anthropics/skills repo)

**Primary sources:** code.claude.com/docs/en/skills (retrieved 2026-08-17); agentskills.io/specification.md + /clients.md + /skill-creation/* (markdown endpoints); `anthropics/skills` repository cloned at HEAD (README + spec redirect).

**Target user:** Two distinct users: (a) the skill *creator* who authors, evaluates, and shares SKILL.md folders; (b) the *operator/admin* who manages which skills load where (enterprise, personal, project, plugin levels) and whether synced skills are trustworthy. Skill Manager's user is the operator (b), but the standard's shape governs what the operator sees.

**Core mental model:** "A skill is a folder containing a SKILL.md file" with required `name` + `description` frontmatter. The standard is explicit that the folder is the unit: `skill-name/` with optional `scripts/`, `references/`, `assets/`. Progressive disclosure is the governing idea: "Discovery: At startup, agents load only the name and description... Activation: When a task matches a skill's description, the agent reads the full SKILL.md instructions into context. Execution: The agent follows the instructions..." - "Full instructions load only when a task calls for them."

**Navigation and entry surface:** Where a skill lives determines who can use it - a documented precedence ladder: "Across levels, enterprise overrides personal, and personal overrides project" and "A skill or command from any of these sources overrides a skill synced from your claude.ai account with the same name." Name collisions are resolved by source level, and plugin skills get a namespace: "Plugin skills use a plugin-name:skill-name namespace, so they can't conflict with other levels" (e.g. `my-plugin:deploy`). Users invoke by `/skill-name`; the `/skills` menu lists what is available and "group[s] synced skills under claude.ai sync" - i.e. provenance is shown *in the entry surface*.

**Detail/workspace model:** Each skill is a directory; SKILL.md is "the entrypoint"; supporting files (templates, examples, scripts, references) are loaded on demand. The spec recommends keeping SKILL.md under 500 lines and moving reference material to separate files. Claude Code extends the standard with invocation control (`disable-model-invocation`), dynamic context injection (!`command`), `allowed-tools` pre-approval, and subagent execution (`context: fork`).

**Attention and action patterns:** Live change detection - "Claude Code watches skill directories for file changes. When you add, edit, or remove a skill... Claude Code picks up the change within the current session, without a restart." Skill quality is an *evaluation loop*, not a review step: the skill-creator plugin runs evals (prompt + expected output + files) and compares with-skill vs without-skill runs in `iteration-N/` directories. Validation is a tool: `skills-ref validate ./my-skill` checks "that your SKILL.md frontmatter is valid and follows all naming conventions."

**Preview, confirmation, rollback, safety patterns:** The strongest safety signals come from the *content* model: "A skill can grant itself broad tool access, so review the allowed-tools of skills checked into a repository before you run Claude Code there." `allowed-tools` grants are scoped: "The grant clears when you send your next message." Synced (cloud) skills are deliberately degraded for local trust: shell execution is disabled/replaced with a placeholder, placeholders are not substituted, and display text is sanitized - an explicit "less-trusted source gets less capability" pattern. Sharing scopes are named: project (commit to VCS), plugin (skills/ directory in a plugin), managed (organization-wide via managed settings).

**Responsive/accessibility cues:** agentskills.io/clients.md renders a responsive grid ("grid-cols-1 md:grid-cols-2") with dark-mode logo variants (`dark:hidden`/`hidden dark:block`) and a shuffle/alphabetical toggle. No formal a11y statement captured (labeled not evidenced).

**Borrow for Skill Manager:**
- **Provenance in the entry surface.** Claude Code labels synced skills in the `/skills` menu; Skill Manager should show origin + variant state in the row/list, not only in the workspace (the README already does this in list strips - the benchmark confirms the choice).
- **Source-level precedence as a displayed ladder.** When copies collide, show "which source wins" as an ordered, explainable rule (Skill Manager's Explain engine already resolves this - the borrow is to render the precedence ladder, not just the verdict).
- **The eval loop as the shape of Adaptation Reviews.** with-skill vs without-skill comparison, iteration directories, and a validation CLI all have direct analogs in Skill Manager's review-cache + verified-apply model. The borrow: make "what changed and who is affected" the artifact, with evidence labels (already the design; this corroborates it).
- **`allowed-tools` review as a first-class attention item.** A skill that can grant itself tool access deserves a review affordance at *first contact* (import) - matches Skill Manager's import/commit/push flow.

**Reject:**
- Cloud-sync trust degradation is not directly applicable (Skill Manager is local-only), but the *principle* - "less provenance = less capability" - already matches Skill Manager's private/local origin rules (no stars, no pinned revisions). Keep as is.

### Supplement: OpenAI GPT Store (official announcement, openai.com/index/introducing-gpts)

**Primary source:** OpenAI "Introducing GPTs" (2023-11-06 announcement page, retrieved 2026-08-17). The store UI itself was not captured (JS/login-walled) - labeled single-source on UI claims.

**Registry model:** GPTs combine "instructions, extra knowledge, and any combination of skills"; anyone can build "for yourself, just for your company's internal use, or for everyone" - three visibility scopes that map cleanly to Skill Manager's origin types. The store is a curated discovery layer: "Once in the store, GPTs become searchable and may climb the leaderboards. We will also spotlight the most useful and delightful GPTs... in categories." Safety: "We've set up new systems to help review GPTs against our usage policies" and users can report via a reporting feature on the shared page; builders can verify identity. Privacy: "Your chats with GPTs are not shared with builders."

**Borrow:** the three visibility scopes as language for origin/visibility states (self / org / public); reporting and policy review as analogs for Skill Manager's security review at import.

**Reject:** leaderboards/ratings as a quality signal - irrelevant and potentially misleading for a local evidence instrument.

### Supplement: smithery.ai (MCP server + skill registry; official site + docs.smithery.ai)

**Primary sources:** smithery.ai home (retrieved 2026-08-17); docs.smithery.ai (introduction + API reference nav). Note: smithery.ai is now part of Arcade.dev per the docs banner ("Smithery is now a part of Arcade.dev").

**Registry model:** The home page is a card grid - each server is a card with name, description, and a docs link; the capture shows the description-led listing (e.g. "Fast, intelligent web search and web crawling..."), plus categories of content (search, verified-news with "citations, confidence scores, and Ethics Engine ratings", commerce, data). The docs expose a `servers` and a `skills` API namespace (per the API reference sidebar), plus token scoping, deep linking, and a publish flow with triggers.

**Borrow:** description-led card listing where the *description is the discovery contract* (matches the Agent Skills standard's "optimize the description" guidance); a documented API surface for the registry (Skill Manager's API already does this - corroboration, no change).

**Reject:** "install from registry" as a remote-first flow. Skill Manager imports into a canonical repo with provenance and preview; one-click remote install would bypass the evidence contract.

---

## Category 3 - Dotfile, configuration, or environment managers

### Deep reference: chezmoi (official docs: quick start + diff reference)

**Primary sources:** www.chezmoi.io/quick-start/ and /reference/commands/diff/ (retrieved 2026-08-17); twpayne/chezmoi README (raw.githubusercontent.com).

**Target user:** The developer managing dotfiles across multiple machines, who treats the home directory as a *target state* driven by a version-controlled *source state*.

**Core mental model:** "chezmoi stores the desired state of your dotfiles in the directory `~/.local/share/chezmoi`. When you run `chezmoi apply`, chezmoi calculates the desired contents for each of your dotfiles and then makes the minimum changes required to make your dotfiles match your desired state." The working copy is the source of truth; the home directory is the derived target. Files are managed (`chezmoi managed`) or unmanaged (`chezmoi unmanaged`) - an explicit boundary.

**Navigation and entry surface:** CLI-first. The loop on one machine: `chezmoi init` -> `chezmoi add ~/.bashrc` (adopt) -> `chezmoi edit` -> `chezmoi diff` (preview) -> `chezmoi -v apply` -> commit/push from the source dir (`chezmoi cd`). On a new machine: `chezmoi init <repo-url>` -> `chezmoi diff` -> `chezmoi apply -v`.

**Detail/workspace model:** Per-file operations with a type system (`--include files|scripts|encrypted...`), templating, and secret management (age/gpg encryption, password-manager integration). `chezmoi diff` accepts targets ("If no targets are specified, print the differences for all targets").

**Attention and action patterns:** The diff IS the attention surface - "See what changes chezmoi would make: `chezmoi diff`" before any write. `-v` (verbose) prints "exactly what changes they will make to the file system"; `-n` (dry run) makes no changes; `-n -v` shows the full plan. If a file's changes are not acceptable, the operator either edits the source or runs a three-way merge: "invoke a merge tool (by default vimdiff) to merge changes between the current contents of the file, the file in your working copy, and the computed contents of the file: `chezmoi merge $FILE`".

**Preview, confirmation, rollback, safety patterns:** Preview (diff) is a mandatory, separate step from apply - the two are never fused. Update pulls + applies the latest source state (`chezmoi update -v`), still diffable. Rollback = revert the source state in git and re-apply; the source repo's history is the undo log. No auto-apply: the user explicitly runs apply after reviewing diff.

**Responsive/accessibility cues:** CLI, no GUI surface in the captured sources (labeled not applicable / not evidenced).

**Borrow for Skill Manager (this is the closest safety analog):**
- The **diff-before-apply as a separate, named step** is exactly Skill Manager's sync preview; the borrow is the *three-way merge* fallback (`chezmoi merge`) when a simple copy would clobber - a candidate for the "conflicting canonical copy" case in origin import.
- `-n -v` ("show the exact plan, change nothing") as an explicit preview verb for skill sync/apply.
- Managed/unmanaged boundary as a visible status (Skill Manager already has this in the Genome strip states; corroboration).
- Source-state-is-truth + git history as the rollback mechanism (Skill Manager's repo-canonical + verified-apply already follow this).

**Reject:** nothing significant - chezmoi's model aligns with Skill Manager's safety contracts.

### Supplements: Home Manager (nix-community) and mise (jdx)

**Primary sources:** nix-community/home-manager README (raw.githubusercontent.com); jdx/mise README (raw.githubusercontent.com).

**Home Manager** - declarative user environment on Nix: "declarative configuration of user specific (non-global) packages and dotfiles." Release-branch discipline ("To avoid breaking users' configurations, Home Manager is released in branches corresponding to NixOS releases... These branches get fixes, but usually not new modules") and an explicit warning: "Unfortunately, it is quite possible to get difficult to understand errors when working with Home Manager" and "In some cases Home Manager cannot detect whether it will overwrite a previous manual configuration." **Borrow:** the honest error-surface warning (named failure modes, not silence) and release-branch pinning as an upstream-update governance pattern (mirrors Skill Manager's pinned-revision model). **Reject:** declarative rebuild complexity - not applicable to Skill Manager's evidence-verification model.

**mise** - "Dev tools, env vars, and tasks in one CLI... It keeps project tools, environment variables, and tasks in one `mise.toml` file so new shells, checkouts, and CI jobs all start from the same setup." A registry of "hundreds more" tools (`mise.jdx.dev/registry.html`), per-directory environments, tasks for build/test/lint/deploy. **Borrow:** single declarative file as the machine-readable identity of an environment (Skill Manager's `skillmgr.yaml` is the same shape - corroboration); registry-as-reference for available tool versions. **Reject:** shim-based runtime interception - out of scope for a skills evidence instrument.

---

## Category 4 - Developer portals or service catalogs

### Deep reference: Backstage Software Catalog (CNCF, originating at Spotify)

**Primary sources:** backstage.io/docs/features/software-catalog/ (overview), /system-model/, /life-of-an-entity/ (retrieved 2026-08-17).

**Target user:** Platform engineers and the teams whose software they catalog; the catalog serves both "teams manage and maintain the software they own" and "makes all the software in your company, and who owns it, discoverable. No more orphan software hiding in the dark corners."

**Core mental model:** "The Backstage Software Catalog is a centralized system that keeps track of ownership and metadata for all the software in your ecosystem... built around the concept of metadata YAML files stored together with the code, which are then harvested and visualized in Backstage." **The source of truth is the metadata YAML in source control**, not the portal's database - "Teams owning the components are responsible for maintaining the metadata about them, and do so using their normal Git workflow." A small typed entity model: "Components are individual pieces of software, APIs are the boundaries between different components, Resources are physical or virtual infrastructure needed to operate a component" (plus Systems, and more kinds).

**Navigation and entry surface:** The catalog lives at `/catalog`; by default it "shows components owned by the team of the logged in user. But you can also switch to All" - an ownership-scoped default with an explicit escape hatch. "Basic inline search and column filtering makes it easy to browse a big set of components." Entities are registered by pointing at the metadata file's URL ("REGISTER EXISTING COMPONENT"), created via Software Templates, or ingested from external sources. Starring exists: "For easy and quick access to components you visit frequently, Backstage supports starring of components."

**Detail/workspace model:** The entity page is the workspace; ownership metadata leads; plugins hang tooling off the catalog ("Rather than asking teams to jump between different infrastructure user interfaces... most of these tools can be organized around the entities in the catalog"). Entities carry relations to other entities (the catalog graph).

**Attention and action patterns:** Processing is continuous and stateful - "the policies and processors continually treat the ingested" entities, emitting errors and relations. Two honesty mechanisms stand out: **Unprocessed Entities** ("The Unprocessed Entities feature helps Backstage admins find and diagnose these entities to understand the state of the catalog") and **orphan detection** ("to be able to detect when an entity becomes orphaned"). Errors are surfaced without destroying the last good state: "If errors are emitted, then that signals that something is wrong with the entity and that it should not replace whatever previously error-free version" existed. Refresh is hash-driven: a processing hash is "compared to hash value from the previous processing."

**Preview, confirmation, rollback, safety patterns:** Because the metadata lives in git, updates flow through the normal review/merge workflow; the catalog reflects merged reality ("Once the change has been merged, Backstage will automatically show the updated metadata... after a short while"). There is no in-portal destructive edit path for catalog content - ownership teams edit YAML in their repos. Error states preserve the last-good entity rather than blanking it.

**Responsive/accessibility cues:** Not evidenced in the captured pages (labeled not evidenced).

**Borrow for Skill Manager:**
- **Metadata-in-VCS as the source of truth, portal as the projection.** Backstage is the strongest external confirmation of Skill Manager's repo-canonical + `skillmgr.yaml` design. Borrow the language: the dashboard is a projection of the repo state, never an independent edit surface.
- **Ownership-scoped default with an explicit "All" escape.** Backstage defaults to "your team's" entities. Skill Manager analog: default the Attention/Browse surface to "skills you own / skills in the canonical repo" with a fleet-wide toggle - reduces noise for the operator.
- **Last-good-state preservation on error.** "should not replace whatever previously error-free version" - already Skill Manager's verify-then-commit contract; corroboration to make it explicit in the UI (show previous verified state beside a failed apply).
- **Unprocessed Entities / orphan detection as named attention categories** - direct analogs for Skill Manager's Unknown/absent-copy states; the borrow is to name the category in the Attention queue (e.g. "unmanaged / origin unknown") rather than only per-skill.

**Reject:**
- Backstage's heavy plugin/tooling integration model - Skill Manager is deliberately a single-context local instrument; cataloging third-party tools around entities adds surface without evidence value.
- Ownership-team YAML workflow as the *only* edit path - Skill Manager's origin import / verified apply exists precisely because skills are installed across harnesses, not just edited in one repo.

---

## Category 5 - Agent, automation, or workflow managers

### Deep reference: n8n (official docs: save/publish, executions, dirty nodes)

**Primary sources:** docs.n8n.io/build/understand-workflows/save-and-publish-workflows.md, /understand-executions.md, /understand-executions/types-of-executions.md, /understand-executions/understand-dirty-nodes.md, and the n8n-io/n8n README (retrieved 2026-08-17).

**Target user:** The automation builder who iterates on workflows (nodes connected on a canvas) and must safely promote drafts to production, and who debugs runs.

**Core mental model:** Draft vs published is a *state machine with visible states*, not a binary: auto-save ("Changes save automatically as you edit, typically within 1 to 5 seconds... All edits remain in draft until you publish"), then publish locks a version: "Publishing makes your workflow live and locks it to a specific version. Production executions will use this published version, not your latest edits." Execution modes are manual (test) vs production (triggered) - "Manual executions allow you to run workflows directly from the canvas to test your workflow logic."

**Navigation and entry surface:** The canvas is the primary surface; the Publish button in the canvas header carries the state. The **Workflows page lists cards with a published indicator**. The **Executions tab** per workflow lists runs for troubleshooting ("you can explore and troubleshoot problems using the debug in editor feature"). Version history is a dedicated view ("Open the version history by selecting the history icon in the header").

**Attention and action patterns:** The publish button is *stateful and explanatory* - documented button states include "No publishable changes (disabled)", "Ready to publish", "Published, up to date", "**Published, has changes**", "**Published, invalid changes**", "**Published, error**". The **dirty node** concept is the standout: "A dirty node is a node that executed successfully in the past, but whose output n8n now considers stale or unreliable... you can identify dirty notes by their different-colored border and a yellow triangle in place of the previous green tick symbol" and "If you hover over the triangle, a tooltip appears with more information about **why** n8n considers the data stale." Staleness causes are named (insert/delete node, modify parameters, add connector, deactivate node, unpin data). Partial executions and **data pinning** ("pin or freeze the output data of a node") let a user test a subset without re-running everything or hitting external services; "Production executions ignore all pinned data."

**Preview, confirmation, rollback, safety patterns:** Publish is a modal with a version name + description; unpublish removes from production; version history supports "Unpublish... Restore a previous version. Restoring lets you work on a version without affecting the production execution. Publish another version... Name a version to protect it from pruning." Collaboration safety: "Only one person can edit a workflow at a time" - others see read-only mode.

**Responsive/accessibility cues:** Hotkeys are first-class (`Shift+P` publish, `Cmd/Ctrl+S` name version, `Cmd/Ctrl+U` unpublish); keyboard shortcuts are documented as a docs section. No formal a11y statement captured (labeled not evidenced).

**Borrow for Skill Manager (the strongest attention/state borrow in this benchmark):**
- **Stateful, explanatory action buttons.** The six publish-button states are the model for Skill Manager's sync/apply entry points: disabled when nothing to do; "ready"; "applied, current"; "applied, has changes"; "blocked (invalid)"; "error". This names *why* an action is unavailable, matching Skill Manager's honest Unknown/blocked conventions.
- **Dirty-node semantics for drift.** "Stale output + a reason" (yellow triangle + hover tooltip explaining the cause) is exactly the pattern Skill Manager's drift strips need: each DRIFT strip should carry the *cause* (which copy changed, when, vs what baseline), not just the delta.
- **Publish-with-version-name** as the shape of verified apply: a named, described version snapshot that production (the fleet) points at, with restore/unpublish in a version history - maps to Skill Manager's snapshots + canonical diff + pinned revision.
- **Partial/pinned execution** has a weak analog in "preview a single skill's apply without touching the fleet" - worth a borrow for the sync preview (already exists; corroboration).
- **Edit lock / read-only for concurrent editors** - relevant only if Skill Manager ever gets shared sessions; today it is local-only, so this is a future guard, not a current need.

**Reject:**
- Auto-save of changes (draft is not an evidence state in a local evidence instrument; Skill Manager's pending items should be explicit, not implicit autosaves).
- Quota-metered executions and monetized plan distinctions - not applicable.

### Deep reference: GitHub Actions (official docs: understanding, re-run, approval)

**Primary sources:** docs.github.com/en/actions/about-github-actions/understanding-github-actions, /managing-workflow-runs-and-deployments/managing-workflow-runs/re-running-workflows-and-jobs, /approving-workflow-runs-from-public-forks (retrieved 2026-08-17).

**Target user:** The developer/CI owner who authors YAML workflows, watches runs, and reviews contributions from forks.

**Core mental model:** "A workflow is a configurable automated process that will run one or more jobs... Workflows are defined by a YAML file checked in to your repository" under `.github/workflows`. The workflow file is the artifact; runs are the observable events; jobs/steps/actions are the decomposition. Repository events trigger runs; runs have history and attempts.

**Navigation and entry surface:** Repository -> Actions tab -> workflow (left sidebar) -> run list -> run summary; the run summary has a visualization graph; jobs are listed in a sidebar. Manual trigger, schedule, and event triggers all exist. The run summary page is the detail/workspace surface.

**Attention and action patterns:** Re-run is *scoped and permissioned*: "You can re-run a workflow run, all failed jobs in a workflow run, or specific jobs in a workflow run up to 30 days after its initial run" - with re-run-all, re-run-failed-jobs, and re-run-specific-job options, each from the run summary. Limits are explicit ("A workflow run can be re-run a maximum of 50 times"). Re-runs are *privilege-bound to the original actor*: "Re-runs use the privileges of the actor who initially triggered the workflow, not the privileges of the actor who initiated the re-run" - a strong safety property. Debug logging is an opt-in on re-run.

**Preview, confirmation, rollback, safety patterns:** Fork-PR runs require human approval: "Workflow runs triggered by a contributor's pull request from a fork may require manual approval from a maintainer with write access" - surfaced as an "Awaiting approval" button that opens the merge status panel with "Approve workflows to run"; "Workflow runs that have been awaiting approval for more than 30 days are automatically deleted." This is the canonical gate-before-execute pattern.

**Responsive/accessibility cues:** Not evidenced in the captured pages (labeled not evidenced).

**Borrow for Skill Manager:**
- **Scoped re-run / retry** (all / failed / one) as the shape of "retry a failed verified-apply": Skill Manager's apply failure currently leaves a retryable commit + Attention item; offering "retry apply only" vs "retry verify only" vs "full re-run" would match operator mental models.
- **Original-actor privilege binding** as a principle for "who can approve what" - relevant if Skill Manager ever runs in a shared/remote context; today local-only, so record as a principle, not a feature.
- **Approval gate with an expiry and a clear CTA** ("Awaiting approval" -> "Approve workflows to run") - the pattern for Skill Manager's typed-acknowledgement gates (executable-behavior changes already require typed acknowledgement; the borrow is the *named waiting state* in the Attention queue).

**Reject:**
- The YAML-file-as-primary-authoring surface. Skill Manager's users manage copies across harnesses; a YAML editor is not the product. Keep preview/apply as the interaction, not file authoring.

---

## Cross-cutting borrow/reject matrix (mapped to Skill Manager surfaces)

| Skill Manager surface | Borrow from | Reject from |
| --- | --- | --- |
| Genome Wall / fleet overview | n8n dirty-node semantics: drift carries a *reason* (yellow-triangle + tooltip); Backstage last-good-state preservation | n8n auto-save (implicit state) |
| Browse + search | VS Code `@filter` query language (`@drift`, `@attention`, `@origin:...`, combinable, with suggestions) | smithery leaderboard/rating signals |
| Detail workspace | chezmoi three-way merge fallback for conflicting canonical copies; Backstage ownership metadata leading the page; provenance shown in entry surface (Claude Code `/skills` labels) | Backstage plugin-tooling sprawl |
| Attention queue | GitHub Actions scoped re-run + named waiting states ("Awaiting approval"); Backstage "Unprocessed Entities" as a named category; Homebrew `outdated` verb | automatic pruning of old versions |
| Sync preview / apply | chezmoi diff-then-apply (separate named steps), `-n -v` plan verb; n8n publish modal with version name + description; VS Code publisher-trust dialog at first origin contact | VS Code auto-update-with-delay |
| Verified apply / rollback | n8n named versions + restore/unpublish; GitHub Actions original-actor privilege binding (principle) | - |
| Upstream updates | Homebrew pin/unpin as "hold this revision"; Home Manager release-branch pinning; mise single declarative file (`skillmgr.yaml` corroboration) | remote one-click install (smithery-style) |
| Variant matrix | Agent Skills source-level precedence ladder rendered as an explainable order; `allowed-tools` review at first contact | - |
| Safety/evidence language | Backstage "should not replace whatever previously error-free version"; n8n "Published, error" state naming; Claude Code less-trust-gets-less-capability for synced skills | - |

## Gaps and no-evidence labels (per the shared evidence rule)

- **marketplace.visualstudio.com item pages** returned HTTP 503 during retrieval; the VS Code details-page model is documented from the official editor docs page instead (single-source for the details-page claims, though the same model is corroborated by the docs' own description of the details page).
- **help.openai.com** returned HTTP 403; GPT Store *UI* specifics (categories, leaderboard mechanics as seen in product) are not evidenced - the announcement page is the cited primary source for GPT Store claims. No store-UI claims are made.
- **smithery.ai grid UI** was captured as rendered card text (name + description + docs link); interactive behaviors (filtering, install commands) are not evidenced beyond the docs API-reference sidebar (`servers`, `skills` namespaces).
- **Responsive/accessibility**: explicitly documented only where the captured page said so (VS Code keyboard/CLI paths, n8n hotkeys, agentskills.io responsive grid + dark mode). For Backstage, GitHub Actions, and chezmoi, responsive/a11y cues were **not present in the captured primary sources** - labeled not evidenced, not inferred. Skill Manager's own tablet/mobile stacked-workspace behavior stands without a benchmark analog.
- **Agent-reach was not needed**: every source above is open-web and reachable via direct primary-source fetch; no platform was blocked in a way that required the fallback layer (per rule 8b, pi-web-access tools were not exposed in this session, so primary-source raw fetches were used at fidelity level 1).

## Source appendix

All retrieved 2026-08-17. Trust class: Web (first-party official docs / official source repositories). Evidence status: direct raw fetch (fidelity level 1) unless noted.

**Category 1 - package/extension/plugin managers**
- VS Code "Extension Marketplace" (official docs): https://code.visualstudio.com/docs/editor/extension-marketplace
- VS Code "Extension Runtime Security" (referenced from the above): https://code.visualstudio.com/docs/editor/extension-marketplace#_can-i-trust-extensions-from-the-marketplace
- Homebrew FAQ (official): https://docs.brew.sh/FAQ

**Category 2 - prompt/skill/agent registries**
- Claude Code "Skills" (official docs): https://code.claude.com/docs/en/skills
- Agent Skills standard - Specification (official): https://agentskills.io/specification.md (also https://agentskills.io/specification)
- Agent Skills - Client Showcase (official): https://agentskills.io/clients.md
- Agent Skills - Best practices / Optimizing descriptions / Evaluating skills (official): https://agentskills.io/skill-creation/best-practices.md, /optimizing-descriptions.md, /evaluating-skills.md
- anthropics/skills repository (official source, cloned at HEAD): https://github.com/anthropics/skills (spec location note: https://agentskills.io/specification)
- OpenAI "Introducing GPTs" (official announcement): https://openai.com/index/introducing-gpts/ (single-source for store mechanics; help.openai.com was 403-blocked)
- smithery.ai (official): https://smithery.ai/ and https://docs.smithery.ai/ (note: smithery is part of Arcade.dev per docs banner)

**Category 3 - dotfile/config/env managers**
- chezmoi Quick start (official docs): https://www.chezmoi.io/quick-start/
- chezmoi diff command reference (official docs): https://www.chezmoi.io/reference/commands/diff/
- twpayne/chezmoi README (official source): https://github.com/twpayne/chezmoi
- Home Manager README (official source): https://github.com/nix-community/home-manager
- mise README + docs (official): https://github.com/jdx/mise, https://mise.jdx.dev/registry.html

**Category 4 - developer portals / service catalogs**
- Backstage Software Catalog overview (official docs): https://backstage.io/docs/features/software-catalog/
- Backstage System Model (official docs): https://backstage.io/docs/features/software-catalog/system-model/
- Backstage "The Life of an Entity" (official docs): https://backstage.io/docs/features/software-catalog/life-of-an-entity/

**Category 5 - agent/automation/workflow managers**
- GitHub Actions "Understanding GitHub Actions" (official docs): https://docs.github.com/en/actions/about-github-actions/understanding-github-actions
- GitHub Actions "Re-running workflows and jobs" (official docs): https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/re-running-workflows-and-jobs
- GitHub Actions "Approving workflow runs from public forks" (official docs): https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/approving-workflow-runs-from-public-forks
- n8n "Save and publish workflows" (official docs): https://docs.n8n.io/build/understand-workflows/save-and-publish-workflows.md
- n8n "Understand executions" / "Types of executions" / "Understand dirty nodes" (official docs): https://docs.n8n.io/build/understand-workflows/understand-executions.md, /understand-executions/types-of-executions.md, /understand-executions/understand-dirty-nodes.md
- n8n-io/n8n README (official source): https://github.com/n8n-io/n8n
