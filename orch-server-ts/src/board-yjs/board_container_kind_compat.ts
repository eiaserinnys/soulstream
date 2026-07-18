import { z } from "zod";

import type { BoardContainerKind, BoardItemType } from "./board_yjs_types.js";

/**
 * Production-gated reader; see docs/task-read-compatibility.md. Callers always
 * receive the canonical kind, and an internal phase cannot remove this branch.
 */
export function normalizeBoardContainerKind(
  value: unknown,
): BoardContainerKind | null {
  if (value === "runbook") return "task";
  return value === "folder" || value === "task" ? value : null;
}

export const boardContainerKindInputSchema = z
  .enum(["folder", "task", "runbook"])
  .transform((value): BoardContainerKind =>
    value === "runbook" ? "task" : value,
  );

export const boardItemTypeInputSchema = z
  .enum(["session", "markdown", "subfolder", "asset", "frame", "task", "custom_view", "runbook"])
  .transform((value): BoardItemType => value === "runbook" ? "task" : value);
