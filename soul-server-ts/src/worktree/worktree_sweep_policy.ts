export const SWEEP_RECENT_MS = 3 * 60 * 60_000;
export const SWEEP_IDLE_MS = 7 * 24 * 60 * 60_000;

export type SweepOutcome = "removed" | "recent" | "in_use" | "base_links"
  | "changes" | "unpushed" | "not_finished" | "failed";

export function decideWorktreeSweep(input: {
  idleMs: number;
  missing: boolean;
  inUse: boolean;
  baseLinks: boolean;
  changes: boolean;
  pushed: boolean;
  merged: boolean;
  linkedCardsClosed: boolean;
}): SweepOutcome {
  if (input.idleMs < SWEEP_RECENT_MS) return "recent";
  if (input.missing) return "removed";
  if (input.inUse) return "in_use";
  if (input.baseLinks) return "base_links";
  if (input.changes) return "changes";
  if (!input.pushed) return "unpushed";
  if (input.merged || input.linkedCardsClosed || input.idleMs >= SWEEP_IDLE_MS) return "removed";
  return "not_finished";
}
