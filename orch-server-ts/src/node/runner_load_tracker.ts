import type { MutableNodeConnection } from "./registry_types.js";
import type { PerNodeSessionCache } from "./session_cache.js";

export type ReportedRunnerLoad = {
  runningSessionCount: number;
  maxConcurrent: number;
};

export function reportedRunnerLoad(
  node: MutableNodeConnection | undefined,
): ReportedRunnerLoad | undefined {
  const maxConcurrent = node?.capabilities.max_concurrent;
  if (
    node === undefined
    || !node.connected
    || node.runningSessionIds === undefined
    || typeof maxConcurrent !== "number"
    || !Number.isSafeInteger(maxConcurrent)
    || maxConcurrent <= 0
  ) {
    return undefined;
  }
  return {
    runningSessionCount: node.runningSessionIds.size,
    maxConcurrent,
  };
}

export function replaceReportedRunnerInventory(
  node: MutableNodeConnection,
  message: Record<string, unknown>,
): void {
  if (message.type !== "runner_inventory" && message.type !== "sessions_update") {
    return;
  }
  const runningSessionIds = message.running_session_ids;
  if (
    !Array.isArray(runningSessionIds)
    || !runningSessionIds.every((value) => typeof value === "string")
  ) {
    return;
  }
  node.runningSessionIds = new Set(runningSessionIds);
}

export function updateReportedRunnerSession(
  node: MutableNodeConnection,
  sessionCache: PerNodeSessionCache,
  message: Record<string, unknown>,
): void {
  if (node.runningSessionIds === undefined) return;
  const sessionId = directSessionId(message);
  if (sessionId === undefined) return;
  const cached = sessionCache.getSessionForNode(node.nodeId, sessionId);
  if (cached?.status === "running") {
    node.runningSessionIds.add(sessionId);
  } else {
    node.runningSessionIds.delete(sessionId);
  }
}

function directSessionId(message: Record<string, unknown>): string | undefined {
  const value = message.agentSessionId ?? message.agent_session_id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
