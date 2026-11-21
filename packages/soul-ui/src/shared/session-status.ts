import type { SessionStatus } from "@soulstream/wire-schema";

export function normalizeSessionStatus(status: unknown): SessionStatus {
  switch (status) {
    case "running":
    case "completed":
    case "error":
    case "interrupted":
    case "unknown":
      return status;
    case "idle":
      return "running";
    default:
      return "unknown";
  }
}
