import type { SessionSummary } from "@seosoyoung/soul-ui";

import type { MobilePlannerTaskOption } from "./mobile-planner-state";
import type { PlannerTask } from "./planner-data";
import { buildRunTree, type RunTreeNode } from "./task-workspace-model";
import type { PlannerDateNavItem } from "./V3Navigation";

export function recentDates(today: string): PlannerDateNavItem[] {
  const base = new Date(`${today}T12:00:00`);
  return [0, 1, 2].map((offset) => {
    const value = new Date(base);
    value.setDate(base.getDate() - offset);
    return {
      date: dateKey(value),
      label: offset === 0
        ? "오늘"
        : offset === 1
          ? "어제"
          : new Intl.DateTimeFormat("ko-KR", {
              month: "numeric",
              day: "numeric",
              weekday: "short",
            }).format(value),
    };
  });
}

export function dateKey(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

export function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function buildMobileTaskOptions(
  tasks: readonly PlannerTask[],
  sessions: readonly SessionSummary[],
): MobilePlannerTaskOption[] {
  const seen = new Set<string>();
  return tasks.flatMap((task) => {
    if (seen.has(task.page.id)) return [];
    seen.add(task.page.id);
    const roots = buildRunTree(task.sessionIds, sessions);
    return [{
      taskId: task.page.id,
      runIds: roots.flatMap(flattenRunIds),
      latestRunId: roots[0]?.session.agentSessionId ?? null,
    }];
  });
}

function flattenRunIds(node: RunTreeNode): string[] {
  return [node.session.agentSessionId, ...node.children.flatMap(flattenRunIds)];
}
