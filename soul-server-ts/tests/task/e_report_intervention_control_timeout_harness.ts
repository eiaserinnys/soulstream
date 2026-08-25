import pino from "pino";
import { vi } from "vitest";

import type { AgentProfile, AgentRegistry } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

export const claudeAgent: AgentProfile = {
  id: "roselin-e",
  name: "Roselin E",
  backend: "claude",
  workspace_dir: "/workspace/e",
};

export function makeAgentRegistry(): AgentRegistry {
  return {
    get: vi.fn(() => claudeAgent),
  } as unknown as AgentRegistry;
}

export function makeTaskMocks() {
  const persistenceDouble = makeEventPersistenceTestDouble();
  const db = {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
  return { ...persistenceDouble, db, broadcaster };
}

export function makeCompletionRepository() {
  let stored: Record<string, unknown> | undefined;
  const turnStarted: string[] = [];
  const consumed: string[] = [];
  const value = {
    register: vi.fn(async (params: Record<string, unknown>) => {
      if (stored) return { row: stored, inserted: false, conflict: false };
      stored = {
        delivery_id: params.deliveryId,
        target_session_id: params.targetSessionId,
        source_session_id: params.sourceSessionId,
        relation_key: params.relationKey,
        completion_id: params.completionId,
        intent: params.intent,
        source: params.source,
        producer_kind: params.producerKind,
        producer_id: params.producerId,
        producer_terminal_revision: params.producerTerminalRevision,
        parent_delivery_id: null,
        caller_turn_id: null,
        payload_hash: params.payloadHash,
        payload: params.payload,
        state: "pending",
        attempt_count: 0,
        lease_owner: null,
        lease_expires_at: null,
        last_error: null,
        created_at: params.createdAt,
        updated_at: params.createdAt,
        claimed_at: null,
        dispatching_at: null,
        queued_at: null,
        delivered_at: null,
        consumed_at: null,
      };
      return { row: stored, inserted: true, conflict: false };
    }),
    get: vi.fn(async () => stored),
    claimForTarget: vi.fn(async (
      _deliveryId: string,
      targetSessionId: string,
      leaseOwner: string,
    ) => {
      stored = {
        ...stored,
        target_session_id: targetSessionId,
        state: "claimed",
        lease_owner: leaseOwner,
      };
      return stored;
    }),
    claimRecoverableCompletionDeliveries: vi.fn().mockResolvedValue([]),
    deferPending: vi.fn(),
    retryLeasedDelivery: vi.fn(),
    releaseExpiredDeliveryLeases: vi.fn().mockResolvedValue(0),
    markUncertain: vi.fn(),
  };
  const consumptionRecorder = {
    recordTurnStarted: vi.fn(async (message: { deliveryId?: string }) => {
      if (!message.deliveryId || stored?.delivery_id !== message.deliveryId) return;
      turnStarted.push(message.deliveryId);
      stored = { ...stored, state: "delivered" };
    }),
    recordConsumed: vi.fn(async (message: { deliveryId?: string }) => {
      if (!message.deliveryId || stored?.delivery_id !== message.deliveryId) return;
      consumed.push(message.deliveryId);
      stored = { ...stored, state: "consumed" };
    }),
    discardIfConsumed: vi.fn(async () => false),
  };
  return {
    value,
    consumptionRecorder,
    durableDeliveryIds(): string[] {
      return stored && typeof stored.delivery_id === "string" ? [stored.delivery_id] : [];
    },
    turnStartedDeliveryIds(): string[] {
      return [...turnStarted];
    },
    consumedDeliveryIds(): string[] {
      return stored?.state === "consumed" ? [...consumed] : [];
    },
  };
}

export function makeCapturingLogger() {
  const warn = vi.fn();
  const value = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn,
  } as unknown as pino.Logger;
  return {
    value,
    errors(): string[] {
      return warn.mock.calls.flatMap((call) => {
        const context = call[0] as { err?: unknown } | undefined;
        return context?.err instanceof Error ? [context.err.message] : [];
      });
    },
  };
}

export function makeSpawnInput(stateDirectory: string, sessionId: string) {
  return {
    stateDirectory,
    sessionId,
    backend: "claude" as const,
    agent: claudeAgent,
    codeSha: "7f9b9e8d",
    snapshotPath: "/release/7f9b9e8d/soul-server-ts",
    codexAdapterMode: "sdk" as const,
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    codexHome: "/home/test/.codex",
    rolloutRoot: "/home/test/.codex/sessions",
  };
}

export function emptyStore(streamId: string) {
  return {
    streamId,
    ackedSeq: 0,
    onAppend: () => () => {},
    async readBatch() { return null; },
    async acknowledge() {},
  };
}
