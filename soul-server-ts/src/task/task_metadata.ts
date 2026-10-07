import type {
  CallerInfo,
  PersistentGenerationFirstCall,
  PersistentGenerationPending,
  PersistentGenerationState,
} from "./task_models.js";
import {
  CLAUDE_PERMISSION_MODES,
  isReasoningEffort,
  type ClaudePermissionMode,
} from "../engine/protocol.js";
import type { SessionCostBase } from "../engine/session_cost.js";

export function buildSessionCostMetadataEntry(
  cost: SessionCostBase,
): Record<string, unknown> {
  return { type: "session_cost", value: { usd: cost.usd, partial: cost.partial } };
}

export function extractSessionCostFromMetadata(metadata: unknown): SessionCostBase | undefined {
  if (!Array.isArray(metadata)) return undefined;
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "session_cost") continue;
    const value = record.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const cost = value as Record<string, unknown>;
    return typeof cost.usd === "number"
      && Number.isFinite(cost.usd)
      && cost.usd >= 0
      && typeof cost.partial === "boolean"
      ? { usd: cost.usd, partial: cost.partial }
      : undefined;
  }
  return undefined;
}

export function buildPersistentSessionMetadataEntry(
  enabled: boolean,
): Record<string, unknown> {
  return {
    type: "persistent_session",
    value: { enabled, updated_at: new Date().toISOString() },
  };
}

export function extractPersistentSession(metadata: unknown): boolean {
  if (!Array.isArray(metadata)) return false;
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "persistent_session") continue;
    const value = record.value;
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && (value as Record<string, unknown>).enabled === true;
  }
  return false;
}

export function buildPersistentGenerationMetadataEntry(
  state: PersistentGenerationState,
): Record<string, unknown> {
  const firstCall = state.firstCall;
  const pending = state.pending;
  return {
    type: "persistent_generation",
    value: {
      number: state.number,
      backend_session_id: state.backendSessionId ?? null,
      started_at: state.startedAt ?? null,
      first_call: firstCall
        ? {
            generation: firstCall.generation,
            input_tokens: firstCall.inputTokens,
            cached_input_tokens: firstCall.cachedInputTokens,
            model_preset: firstCall.modelPreset,
            model: firstCall.model,
            measured_at: firstCall.measuredAt,
            ...(firstCall.contextReset === undefined
              ? {}
              : { context_reset: firstCall.contextReset }),
          }
        : null,
      pending: pending
        ? {
            number: pending.number,
            reason: pending.reason,
            requested_at: pending.requestedAt,
            target_model_preset: pending.targetModelPreset,
            target_reasoning_effort: pending.targetReasoningEffort ?? null,
            reset_context: pending.resetContext ?? false,
            keep_instructions: pending.keepInstructions ?? true,
            applying_from: pending.applyingFrom ?? null,
            ...(pending.applyingFrom === undefined
              ? {}
              : {
                  previous_model_preset: pending.previousModelPreset ?? null,
                  ...(pending.previousBackend === undefined
                    ? {}
                    : { previous_backend: pending.previousBackend }),
                }),
          }
        : null,
    },
  };
}

export function extractPersistentGeneration(
  metadata: unknown,
): PersistentGenerationState | undefined {
  if (!Array.isArray(metadata)) return undefined;
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "persistent_generation") continue;
    const value = record.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const recordValue = value as Record<string, unknown>;
    const firstCall = parsePersistentGenerationFirstCall(recordValue.first_call);
    const pending = parsePersistentGenerationPending(recordValue.pending);
    return {
      number: positiveSafeInteger(recordValue.number) ? recordValue.number : 1,
      ...(typeof recordValue.backend_session_id === "string"
        ? { backendSessionId: recordValue.backend_session_id }
        : {}),
      ...(typeof recordValue.started_at === "string"
        ? { startedAt: recordValue.started_at }
        : {}),
      ...(firstCall === undefined ? {} : { firstCall }),
      ...(pending === undefined ? {} : { pending }),
    };
  }
  return undefined;
}

function parsePersistentGenerationFirstCall(value: unknown):
  PersistentGenerationFirstCall | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !positiveSafeInteger(record.generation)
    || !nonNegativeFiniteNumber(record.input_tokens)
    || !nonNegativeFiniteNumber(record.cached_input_tokens)
    || typeof record.model_preset !== "string"
    || typeof record.model !== "string"
    || typeof record.measured_at !== "string"
  ) {
    return undefined;
  }
  return {
    generation: record.generation,
    inputTokens: record.input_tokens,
    cachedInputTokens: record.cached_input_tokens,
    modelPreset: record.model_preset,
    model: record.model,
    measuredAt: record.measured_at,
    ...(typeof record.context_reset === "boolean"
      ? { contextReset: record.context_reset }
      : {}),
  };
}

function parsePersistentGenerationPending(value: unknown):
  PersistentGenerationPending | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !positiveSafeInteger(record.number)
    || typeof record.reason !== "string"
    || typeof record.requested_at !== "string"
    || typeof record.target_model_preset !== "string"
  ) {
    return undefined;
  }
  return {
    number: record.number,
    reason: record.reason,
    requestedAt: record.requested_at,
    targetModelPreset: record.target_model_preset,
    resetContext: record.reset_context === true,
    keepInstructions: record.keep_instructions !== false,
    ...(isReasoningEffort(record.target_reasoning_effort)
      ? { targetReasoningEffort: record.target_reasoning_effort }
      : {}),
    ...(typeof record.applying_from === "string"
      ? { applyingFrom: record.applying_from }
      : {}),
    ...(record.previous_model_preset === null || typeof record.previous_model_preset === "string"
      ? { previousModelPreset: record.previous_model_preset }
      : {}),
    ...(typeof record.previous_backend === "string"
      ? { previousBackend: record.previous_backend }
      : {}),
  };
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * 정체성을 명시하는 source는 신원 필드가 비어도 *신원 박힘*으로 간주.
 */
const IDENTITY_BEARING_SOURCES: ReadonlySet<string> = new Set([
  "agent",
  "system",
  "slack",
  "soul-app",
  "channel_observer",
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

export function extractClaudePermissionModeFromMetadata(
  metadata: unknown,
): ClaudePermissionMode | undefined {
  if (!Array.isArray(metadata)) return undefined;
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i];
    if (!entry || typeof entry !== "object") continue;
    const recordEntry = entry as Record<string, unknown>;
    if (recordEntry.type !== "claude_permission_mode") continue;
    const value = recordEntry.value;
    if (!value || typeof value !== "object") continue;
    const mode = (value as Record<string, unknown>).mode;
    return isClaudePermissionMode(mode) ? mode : undefined;
  }
  return undefined;
}

export interface ClaudeBackendRolloverMetadataState {
  attempts: number;
  phase: "pending" | "completed";
  previousSessionId?: string;
  backendSessionId?: string;
}

export function extractClaudeBackendRolloverState(
  metadata: unknown,
): ClaudeBackendRolloverMetadataState {
  if (!Array.isArray(metadata)) return defaultClaudeBackendRolloverState();
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i];
    if (!entry || typeof entry !== "object") continue;
    const recordEntry = entry as Record<string, unknown>;
    if (recordEntry.type !== "claude_backend_rollover") continue;
    const value = recordEntry.value;
    if (!value || typeof value !== "object") return defaultClaudeBackendRolloverState();
    const record = value as Record<string, unknown>;
    const attempts = typeof record.attempts === "number"
      && Number.isSafeInteger(record.attempts)
      && record.attempts >= 0
      ? record.attempts
      : 0;
    const phase = record.phase === "pending" || record.phase === "completed"
      ? record.phase
      : attempts > 0 ? "pending" : "completed";
    return {
      attempts,
      phase,
      ...(typeof record.previous_session_id === "string"
        ? { previousSessionId: record.previous_session_id }
        : {}),
      ...(typeof record.backend_session_id === "string"
        ? { backendSessionId: record.backend_session_id }
        : {}),
    };
  }
  return defaultClaudeBackendRolloverState();
}

function defaultClaudeBackendRolloverState(): ClaudeBackendRolloverMetadataState {
  return { attempts: 0, phase: "completed" };
}

export function buildCallerInfoMetadataEntry(
  callerInfo: CallerInfo | undefined,
): Record<string, unknown> | undefined {
  if (!callerInfo || Object.keys(callerInfo).length === 0) return undefined;
  return { type: "caller_info", value: callerInfo };
}

export function buildClaudePermissionModeMetadataEntry(
  mode: ClaudePermissionMode | undefined,
): Record<string, unknown> | undefined {
  if (!mode) return undefined;
  return { type: "claude_permission_mode", value: { mode } };
}

function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === "string" && CLAUDE_PERMISSION_MODES.includes(value as ClaudePermissionMode);
}
