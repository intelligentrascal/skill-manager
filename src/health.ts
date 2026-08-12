export interface HealthCopy {
  location: string;
  sha: string;
  repoClean?: boolean;
}

export interface HealthInventory {
  byName: Record<string, HealthCopy[]>;
}

export interface HealthAction {
  kind: "drift" | "repo_dirty";
  priority: "high" | "medium";
  skill: string;
  title: string;
  detail: string;
}

export function buildHealthActions(inventory: HealthInventory): HealthAction[] {
  const actions: HealthAction[] = [];

  for (const [skill, copies] of Object.entries(inventory.byName)) {
    const locations = [...new Set(copies.map((copy) => copy.location))].sort(
      (left, right) => left.localeCompare(right),
    );
    const shas = new Set(copies.map((copy) => copy.sha));

    if (shas.size > 1) {
      actions.push({
        kind: "drift",
        priority: "high",
        skill,
        title: "Resolve drift",
        detail: `${locations.join(" and ")} have different SKILL.md content.`,
      });
    }

    if (copies.some((copy) => copy.location === "repo" && copy.repoClean === false)) {
      actions.push({
        kind: "repo_dirty",
        priority: "medium",
        skill,
        title: "Review repo change",
        detail: "Git status reports that the repo copy changed from HEAD.",
      });
    }
  }

  return actions.sort((left, right) => {
    if (left.priority === right.priority) {
      return left.skill.localeCompare(right.skill);
    }
    return left.priority === "high" ? -1 : 1;
  });
}
