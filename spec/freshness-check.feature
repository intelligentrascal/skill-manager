# language: en
Feature: Per-skill upstream freshness check and in-pane update

  After a canonical origin is assigned, the skill pane must let the user
  (a) manually pull GitHub to learn whether the skill is up to date, drifted,
  or unreachable, and (b) update the skill through the established
  review -> verified-apply flow against the pinned upstream revision (or an
  explicit re-pin). Freshness is fetched on demand, reported honestly, and
  never applied silently.

  Background:
    Given the skill manager is running against the agent-skills repo mirror
    And a mocked upstream GitHub remote is available at "https://github.com/acme/skills.git"
    And the skill "example-skill" lives at subpath "skills/example-skill" in that remote

  # ---------------------------------------------------------------------------
  # Freshness check (acceptance criterion 1): manual, on demand, honest.
  # The three canonical user-facing states are up-to-date / update-available /
  # unreachable; local drift is reported as its own honest state, never folded
  # silently into "up to date".
  # ---------------------------------------------------------------------------

  Scenario: Freshness check reports up to date when local matches pin and upstream has not moved
    Given the manifest records "example-skill" with a verified public GitHub origin
      (upstreamUrl "https://github.com/acme/skills.git", subpath "skills/example-skill", pinnedRevision "REV1")
    And the local repo copy of "example-skill" matches the content at "REV1"
    And the upstream HEAD is still "REV1"
    When the user triggers the freshness check in the skill pane
    Then the pane reports "Up to date"
    And the pane does not offer an update action

  Scenario: Freshness check reports update available when upstream advanced past the pinned revision
    Given the manifest records "example-skill" with a verified public GitHub origin
      (upstreamUrl "https://github.com/acme/skills.git", subpath "skills/example-skill", pinnedRevision "REV1")
    And the local repo copy of "example-skill" matches the content at "REV1"
    And the upstream HEAD has advanced to "REV2"
    When the user triggers the freshness check in the skill pane
    Then the pane reports "Update available"
    And the pane names the source repo "acme/skills" in the report
    And the pane surfaces the update path (review -> verified apply)

  Scenario: Freshness check reports drifted when the local copy diverges from the pinned revision
    Given the manifest records "example-skill" with a verified public GitHub origin
      (upstreamUrl "https://github.com/acme/skills.git", subpath "skills/example-skill", pinnedRevision "REV1")
    And the local repo copy of "example-skill" has been edited and no longer matches "REV1"
    And the upstream HEAD is still "REV1"
    When the user triggers the freshness check in the skill pane
    Then the pane reports "Drifted" (local copy differs from the pinned revision)
    And the pane does not claim the skill is "Up to date"

  Scenario: Freshness check reports unreachable honestly and never silently
    Given the manifest records "example-skill" with a verified public GitHub origin
      (upstreamUrl "https://github.com/acme/skills.git", subpath "skills/example-skill", pinnedRevision "REV1")
    And the upstream remote is unreachable (network failure)
    When the user triggers the freshness check in the skill pane
    Then the pane reports "Unreachable" with the fetch error surfaced
    And the pane does not report "Up to date" or "Update available"

  Scenario: No freshness check action for a skill without a verified public GitHub origin
    Given the skill "local-skill" has a "local" origin and no identity in the manifest
    When the user opens the skill pane for "local-skill"
    Then the freshness check action is not shown
    And no upstream fetch is attempted

  # ---------------------------------------------------------------------------
  # In-pane update path (acceptance criterion 2): reuses #6 review + #7 apply.
  # Applying still requires preview/confirmation; it is never automatic.
  # ---------------------------------------------------------------------------

  Scenario: Update path runs the review then the verified apply against the pinned revision
    Given the manifest records "example-skill" with a verified public GitHub origin
      (upstreamUrl "https://github.com/acme/skills.git", subpath "skills/example-skill", pinnedRevision "REV2")
    And the local repo copy of "example-skill" still matches the content at "REV1"
    When the user opens the update path in the skill pane
    Then an Adaptation Review is generated (the #6 review service) with the current
      repo copy as baseline and the content at the pinned revision "REV2" as incoming
    And the review shows the change summary and per-agent proposals
    And no apply has happened yet (preview only)
    When the user confirms apply after reviewing the preview
    Then the verified apply (the #7 apply service) runs stage -> deploy -> verify -> commit -> push
    And the local canonical copy now matches the content at "REV2"
    And the manifest records the applied revision in provenance

  Scenario: Applying still requires an explicit preview and confirmation
    Given the update path has produced an Adaptation Review for "example-skill"
    When the user has not yet reviewed and confirmed the preview
    Then no apply is performed
    And no commit or push is made

  Scenario: Updating to a newer revision requires an explicit re-pin
    Given the manifest records "example-skill" with a verified public GitHub origin
      (upstreamUrl "https://github.com/acme/skills.git", subpath "skills/example-skill", pinnedRevision "REV1")
    And the upstream HEAD has advanced to "REV2"
    And freshness reports "Update available"
    When the user explicitly re-pins the origin to "REV2"
    Then the review -> verified-apply flow runs against the newly pinned revision "REV2"

  # ---------------------------------------------------------------------------
  # Clarified labels (acceptance criterion 3): name the source repo, show only
  # when meaningful. The user never guesses which repo is meant.
  # ---------------------------------------------------------------------------

  Scenario: Sync label names the source repo explicitly
    Given "example-skill" has a repo copy and at least one drifted non-repo copy
    When the user opens the skill pane for "example-skill"
    Then the sync action label states the source repo explicitly
      (e.g. "Preview sync from agent-skills repo copy"), never a bare "Preview sync from repo"
    And the sync preview panel title also names the source repo

  Scenario: Sync action is hidden when it is not meaningful
    Given "example-skill" has a repo copy but no drifted non-repo copies
    When the user opens the skill pane for "example-skill"
    Then the sync action is not shown
