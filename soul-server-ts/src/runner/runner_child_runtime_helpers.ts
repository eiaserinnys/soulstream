import { writeFile } from "node:fs/promises";

import {
  buildEventOutboxAppendInput,
} from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { EventOutboxSessionEffect } from "../upstream/event_outbox.js";
import { engineEventFrame } from "./frame_protocol.js";
import type { RunnerChildConfig } from "./runner_process_spawn.js";

export function runnerLivenessIntervalMs(leaseTimeoutMs: number): number {
  if (!Number.isSafeInteger(leaseTimeoutMs) || leaseTimeoutMs <= 0) {
    throw new Error("runner lease timeout must be a positive integer");
  }
  return Math.max(1, Math.min(30_000, Math.floor(leaseTimeoutMs / 3)));
}

export function runnerToolLeaseTransition(event: SSEEventPayload):
  | { kind: "start" | "finish"; toolUseId: string }
  | null {
  const type = (event as { type?: unknown }).type;
  if (type !== "tool_start" && type !== "tool_result") return null;
  const toolUseId = (event as { tool_use_id?: unknown }).tool_use_id;
  if (typeof toolUseId !== "string" || toolUseId.length === 0) return null;
  return { kind: type === "tool_start" ? "start" : "finish", toolUseId };
}

export function buildDurableRunnerEvent(
  sessionId: string,
  event: SSEEventPayload,
  effect?: EventOutboxSessionEffect,
  metadata?: unknown,
): {
  appendInput: ReturnType<typeof buildEventOutboxAppendInput>;
  frame: ReturnType<typeof engineEventFrame>;
} {
  const appendInput = buildEventOutboxAppendInput(sessionId, event, effect);
  return {
    appendInput,
    frame: engineEventFrame(appendInput.payload, metadata),
  };
}

export function sessionIdEffect(
  event: SSEEventPayload,
): EventOutboxSessionEffect | undefined {
  if ((event as { type?: unknown }).type !== "session") return undefined;
  const sessionId = (event as { session_id?: unknown }).session_id;
  return typeof sessionId === "string" && sessionId.length > 0
    ? { kind: "set_backend_session_id", backend_session_id: sessionId }
    : undefined;
}

export function backendSessionRotationEffect(
  expectedBackendSessionId: string,
  backendSessionId: string,
): EventOutboxSessionEffect {
  return {
    kind: "rotate_backend_session_id",
    expected_backend_session_id: expectedBackendSessionId,
    backend_session_id: backendSessionId,
  };
}

export function requiresBackendSessionId(backend: RunnerChildConfig["backend"]): boolean {
  return backend === "claude" || backend === "codex";
}

export async function setRunnerOomScore(
  platform: NodeJS.Platform = process.platform,
  path = "/proc/self/oom_score_adj",
): Promise<void> {
  if (platform !== "linux") return;
  await writeFile(path, "500\n");
}

export function isSqliteFullError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "SQLITE_FULL" || /database or disk is full/i.test(error.message);
}
