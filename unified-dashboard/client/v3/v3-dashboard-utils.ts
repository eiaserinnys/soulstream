import { resolveLanguage } from "@soulstream/i18n";
import { formatWorkspaceTime as workspaceTime } from "@seosoyoung/soul-ui/lib/format-workspace-time";
import type { useTranslation } from "react-i18next";
import type { CatalogFolder, SessionSummary } from "@seosoyoung/soul-ui";

import type { MobilePlannerFolderOption } from "./mobile-planner-state";
import { buildRunTree, type RunTreeNode } from "./folder-workspace-run-model";

type Translate = ReturnType<typeof useTranslation>["t"];
export function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function writeFailureText(action: string, error: unknown, t: Translate): string {
  return errorStatus(error) === 401
    ? t("sessions.authExpired")
    : t("sessions.writeFailure", { action, detail: errorText(error) });
}

export function reportV3WriteFailure({
  action,
  error,
  notify,
  refreshAuthStatus,
  t,
}: {
  action: string;
  error: unknown;
  notify(message: string): void;
  refreshAuthStatus(): void;
  t: Translate;
}): string {
  const message = writeFailureText(action, error, t);
  notify(message);
  if (errorStatus(error) === 401) refreshAuthStatus();
  return message;
}

export function buildMobileFolderOptions(
  folders: readonly CatalogFolder[],
  sessions: readonly SessionSummary[],
): MobilePlannerFolderOption[] {
  return folders.filter((folder) => !folder.archived).map((folder) => {
    const sessionIds = sessions.filter((session) => session.folderId === folder.id)
      .map((session) => session.agentSessionId);
    const roots = buildRunTree(sessionIds, sessions);
    return {
      folderId: folder.id,
      runIds: roots.flatMap(flattenRunIds),
      latestRunId: roots[0]?.session.agentSessionId ?? null,
    };
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

export function formatWorkspaceTime(value: string | null | undefined, language: string): string {
  return workspaceTime(value, resolveLanguage(language, []));
}
