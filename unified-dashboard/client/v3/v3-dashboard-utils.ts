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

export const AUTH_EXPIRED_MESSAGE = "로그인이 만료되었습니다. 다시 로그인해 주세요";

export function writeFailureText(action: string, error: unknown): string {
  return errorStatus(error) === 401
    ? AUTH_EXPIRED_MESSAGE
    : `${action} 실패 · ${errorText(error)}`;
}

export function reportV3WriteFailure({
  action,
  error,
  notify,
  refreshAuthStatus,
}: {
  action: string;
  error: unknown;
  notify(message: string): void;
  refreshAuthStatus(): void;
}): string {
  const message = writeFailureText(action, error);
  notify(message);
  if (errorStatus(error) === 401) refreshAuthStatus();
  return message;
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

function errorStatus(error: unknown, seen = new Set<object>()): number | null {
  if (error && typeof error === "object") {
    if (seen.has(error)) return null;
    seen.add(error);
    if ("status" in error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number") return status;
    }
    const messageMatch = /\b([45]\d{2})\b/.exec(errorText(error));
    if (messageMatch) return Number(messageMatch[1]);
    if ("cause" in error) {
      return errorStatus((error as { cause?: unknown }).cause, seen);
    }
  }
  const match = /\b([45]\d{2})\b/.exec(errorText(error));
  return match ? Number(match[1]) : null;
}
