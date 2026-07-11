import type { SessionStatus } from "../shared/types";

export type PageLens = "default" | "running" | "completed";
export type SessionLensState = "neutral" | "match" | "dimmed";

export function isPageLens(value: string | null | undefined): value is PageLens {
  return value === "default" || value === "running" || value === "completed";
}

export function sessionLensState(
  status: SessionStatus | undefined,
  lens: PageLens,
): SessionLensState {
  if (lens === "default" || status === undefined) return "neutral";
  return status === lens ? "match" : "dimmed";
}
