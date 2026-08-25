import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { vi } from "vitest";

import type { AgentProfile, AgentRegistry } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import type { Task } from "../../src/task/task_models.js";
import {
  engineEventFrame,
  executionEndedControlFrame,
  outboxAvailableControlFrame,
  type RunnerCommandFrame,
} from "../../src/runner/frame_protocol.js";
import { RunnerSocketEndpoint } from "../../src/runner/runner_socket_endpoint.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

export async function makeTemporaryDirectory(directories: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-e-report-red-"));
  directories.push(directory);
  return directory;
}

export function makeDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function provesExpectedNextTurn(
  frame: Extract<RunnerCommandFrame, { kind: "execute" }>,
  deliveryId: string,
): boolean {
  return frame.params.runnerInterventionId === deliveryId
    && frame.params.inputUuid === buildDeliveryInputUuid(deliveryId)
    && frame.params.turnOrigin?.kind === "completion_notification"
    && frame.params.turnOrigin.id === deliveryId
    && frame.params.prompt.includes("fresh E report");
}

export async function emitSuccessfulNextTurn(
  outbox: RunnerSqliteEventOutbox,
  endpoint: RunnerSocketEndpoint,
  frame: Extract<RunnerCommandFrame, { kind: "execute" }>,
  sessionId: string,
  deliveryId: string,
): Promise<void> {
  if (!provesExpectedNextTurn(frame, deliveryId)) {
    throw new Error("second execute did not carry the fresh E report identity");
  }
  await emitSuccessfulTurn(outbox, endpoint, frame.commandId, sessionId, "next turn");
}

export async function emitSuccessfulTurn(
  outbox: RunnerSqliteEventOutbox,
  endpoint: RunnerSocketEndpoint,
  commandId: string,
  sessionId: string,
  label: "foreground" | "next turn",
): Promise<void> {
  const payloads = [
    { type: "assistant_message", content: `${label} assistant` },
    { type: "result", success: true, output: `${label} result`, timestamp: 2 },
    { type: "complete", result: `${label} completed`, timestamp: 3 },
  ];
  let terminalSourceSeq = 0;
  for (const payload of payloads) {
    const record = await outbox.appendEngineFrame({
      session_id: sessionId,
      event_type: payload.type,
      payload,
      searchable_text: "content" in payload ? payload.content : null,
      created_at: "2026-08-25T00:00:03.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
    }, engineEventFrame(payload));
    terminalSourceSeq = record.source_seq;
  }
  await endpoint.currentConnection!.send(outboxAvailableControlFrame(terminalSourceSeq));
  await endpoint.currentConnection!.send(executionEndedControlFrame(commandId));
}

export function eventPayloadField(payload: unknown, key: string): unknown {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

export const claudeAgent: AgentProfile = {
  id: "roselin-e",
  name: "Roselin E",
  backend: "claude",
  workspace_dir: "/workspace/e",
};

export function makeEParentTask(sessionId: string): Task {
  return {
    agentSessionId: sessionId,
    prompt: "parent foreground turn",
    status: "running",
    profileId: claudeAgent.id,
    modelPresetBackend: "claude",
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

export function makeECompletedChild(input: {
  childSessionId: string;
  parentSessionId: string;
  terminalRevision: string;
}): Task {
  return {
    agentSessionId: input.childSessionId,
    prompt: "child work",
    status: "completed",
    profileId: claudeAgent.id,
    callerSessionId: input.parentSessionId,
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    completedAt: new Date("2026-08-25T00:00:01.000Z"),
    lastEventId: Number(input.terminalRevision),
    terminalEventId: Number(input.terminalRevision),
    lastReadEventId: 0,
    lastAssistantText: "fresh E report",
    interventionQueue: [],
  };
}

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

export function makeCompletionRepository(observers?: {
  onTurnStarted?(deliveryId: string): void;
  onConsumed?(deliveryId: string): void;
}) {
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
      observers?.onTurnStarted?.(message.deliveryId);
      stored = { ...stored, state: "delivered" };
    }),
    recordConsumed: vi.fn(async (message: { deliveryId?: string }) => {
      if (!message.deliveryId || stored?.delivery_id !== message.deliveryId) return;
      consumed.push(message.deliveryId);
      observers?.onConsumed?.(message.deliveryId);
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
