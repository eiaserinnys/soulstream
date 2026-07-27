import type { SSEEventPayload } from "./protocol.js";

export type ClaudeBackgroundProvenance =
  | "sdk_membership"
  | "explicit_background_tool_result"
  | "runtime_close";

const BACKGROUND_PROVENANCE = Symbol("claude-background-provenance");

/**
 * Task lifecycle messages are generic. Background ownership is internal metadata
 * proven by SDK membership (or an equally explicit background boundary), not by
 * the mere presence of task_notification/task_updated.
 */
export function attachClaudeBackgroundProvenance(
  target: object,
  provenance: ClaudeBackgroundProvenance,
): void {
  if (readClaudeBackgroundProvenance(target)) return;
  Object.defineProperty(target, BACKGROUND_PROVENANCE, {
    configurable: false,
    enumerable: false,
    value: provenance,
    writable: false,
  });
}

export function readClaudeBackgroundProvenance(
  target: object,
): ClaudeBackgroundProvenance | undefined {
  return (target as Record<symbol, ClaudeBackgroundProvenance | undefined>)[
    BACKGROUND_PROVENANCE
  ];
}

export function copyClaudeBackgroundProvenance(
  event: object,
  payloads: SSEEventPayload[],
): SSEEventPayload[] {
  const provenance = readClaudeBackgroundProvenance(event);
  if (!provenance) return payloads;
  for (const payload of payloads) {
    attachClaudeBackgroundProvenance(payload, provenance);
  }
  return payloads;
}
