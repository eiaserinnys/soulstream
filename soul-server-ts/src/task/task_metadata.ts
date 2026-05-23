import type { CallerInfo } from "./task_models.js";

/**
 * Python `IDENTITY_BEARING_SOURCES` 정본(`packages/soul-common/.../auth/caller_info.py:362-370`).
 * 정체성 명시 source는 신원 필드가 비어도 *신원 박힘*으로 간주.
 */
const IDENTITY_BEARING_SOURCES: ReadonlySet<string> = new Set([
  "agent",
  "system",
  "slack",
  "soul-app",
  "channel_observer",
  "trello_watcher",
  "llm",
]);

export interface AgentsRunStateMetadata {
  serialized?: string;
  pendingApprovalId?: string;
  previousResponseId?: string;
  conversationId?: string;
  schemaVersion?: string;
}

/** Python `has_caller_identity` 정본 (`auth/caller_info.py:96-116`). */
function hasCallerIdentity(callerInfo: CallerInfo): boolean {
  const source = typeof callerInfo.source === "string" ? callerInfo.source : undefined;
  if (source && IDENTITY_BEARING_SOURCES.has(source)) {
    return true;
  }
  return Boolean(callerInfo.display_name || callerInfo.avatar_url);
}

/**
 * Python `extract_caller_info_from_metadata` 정본 인라인 이식 (R-6 fix, atom G-20).
 *
 * sessions.metadata JSONB array를 순회하여 *마지막 신원 박힌* caller_info entry value 반환.
 * 부재 시 마지막 *어떤* caller_info entry value라도 반환 (graceful — 옛 데이터 보존).
 * caller_info entry 0건이면 undefined.
 */
export function extractCallerInfoFromMetadata(metadata: unknown): CallerInfo | undefined {
  if (!Array.isArray(metadata)) return undefined;
  let lastAny: CallerInfo | undefined;
  let lastWithIdentity: CallerInfo | undefined;
  for (const entry of metadata) {
    if (
      !entry ||
      typeof entry !== "object" ||
      (entry as Record<string, unknown>).type !== "caller_info"
    ) {
      continue;
    }
    const value = (entry as Record<string, unknown>).value;
    if (!value || typeof value !== "object") continue;
    const ci = value as CallerInfo;
    lastAny = ci;
    if (hasCallerIdentity(ci)) {
      lastWithIdentity = ci;
    }
  }
  return lastWithIdentity ?? lastAny;
}

export function extractAgentsRunStateFromMetadata(
  metadata: unknown,
): AgentsRunStateMetadata | undefined {
  if (!Array.isArray(metadata)) return undefined;
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i];
    if (!entry || typeof entry !== "object") continue;
    const recordEntry = entry as Record<string, unknown>;
    if (recordEntry.type !== "agents_run_state") continue;
    const value = recordEntry.value;
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.backend !== "openai-agents") continue;
    const serialized = typeof record.serialized === "string" && record.serialized.length > 0
      ? record.serialized
      : undefined;
    return {
      serialized,
      pendingApprovalId: typeof record.pendingApprovalId === "string"
        ? record.pendingApprovalId
        : undefined,
      previousResponseId: typeof record.previousResponseId === "string"
        ? record.previousResponseId
        : undefined,
      conversationId: typeof record.conversationId === "string"
        ? record.conversationId
        : undefined,
      schemaVersion: typeof record.schemaVersion === "string" ? record.schemaVersion : undefined,
    };
  }
  return undefined;
}

export function extractAgentsSessionItemsFromMetadata(metadata: unknown): unknown[] | undefined {
  if (!Array.isArray(metadata)) return undefined;
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i];
    if (!entry || typeof entry !== "object") continue;
    const recordEntry = entry as Record<string, unknown>;
    if (recordEntry.type !== "agents_session_items") continue;
    const value = recordEntry.value;
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.backend !== "openai-agents") continue;
    return Array.isArray(record.items) ? record.items : undefined;
  }
  return undefined;
}

export function buildCallerInfoMetadataEntry(
  callerInfo: CallerInfo | undefined,
): Record<string, unknown> | undefined {
  if (!callerInfo || Object.keys(callerInfo).length === 0) return undefined;
  return { type: "caller_info", value: callerInfo };
}
