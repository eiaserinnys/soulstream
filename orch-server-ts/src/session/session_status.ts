export const TERMINAL_SESSION_STATUSES = [
  "completed",
  "error",
  "interrupted",
] as const;

export type TerminalSessionStatus = typeof TERMINAL_SESSION_STATUSES[number];

export function isTerminalSessionStatus(
  status: string | undefined,
): status is TerminalSessionStatus {
  return typeof status === "string"
    && TERMINAL_SESSION_STATUSES.includes(status as TerminalSessionStatus);
}
