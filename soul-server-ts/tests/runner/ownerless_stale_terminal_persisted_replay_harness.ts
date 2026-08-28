import pino from "pino";

import {
  createApp,
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../../../orch-server-ts/src/index.js";
import { SessionReadRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_read_repository.js";
import { NodeEventIngressController } from
  "../../../orch-server-ts/src/node/event_ingress_controller.js";
import {
  EventIngressRepository,
  type EventIngressSql,
} from "../../../orch-server-ts/src/node/event_ingress_repository.js";
import { applyEventSessionEffect } from
  "../../../orch-server-ts/src/node/event_session_effect_applier.js";
import type {
  EventAppendAck,
  EventAppendBatch,
  EventIngressResult,
  EventSessionEffectApplication,
} from "../../../orch-server-ts/src/node/event_ingress_types.js";
import { InMemoryNodeRegistry } from
  "../../../orch-server-ts/src/node/registry.js";
import { buildEventOutboxAppendInput } from "../../src/db/event_persistence.js";
import type { SessionRow } from "../../src/db/session_db.js";
import {
  computeEventOutboxPayloadHash,
  type EventOutboxRecord,
  type EventOutboxSessionEffect,
} from "../../src/upstream/event_outbox.js";
import { hydrateEvictedTaskFromSessionRow } from
  "../../src/task/task_evicted_hydration.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { Task } from "../../src/task/task_models.js";
import type { FullSchemaPostgresHarness } from
  "../db/full_schema_postgres_harness.js";
import {
  LIVE_OWNER_IDENTITY,
  OWNERLESS_NODE_ID,
} from "./ownerless_running_reconciliation_fixture.js";
import type {
  PersistedAppliedTerminalReplayObservation,
  PersistedStaleTerminalReplayObservation,
} from "./ownerless_stale_terminal_persisted_replay_oracle.js";

const STALE_SESSION_ID = "ownerless-row2-stale-terminal-persisted-replay";
const APPLIED_SESSION_ID = "ownerless-row2-applied-terminal-persisted-replay";
const STALE_STREAM_ID = "00000000-0000-4000-8000-000000000311";
const STALE_ACQUIRE_STREAM_ID = "00000000-0000-4000-8000-000000000312";
const APPLIED_STREAM_ID = "00000000-0000-4000-8000-000000000313";
const APPLIED_CURSOR_STREAM_ID = "00000000-0000-4000-8000-000000000314";
const EVENT_AT = new Date("2026-08-28T06:00:00.000Z");
const logger = pino({ level: "silent" });

type CanonicalSnapshot = {
  status: string;
  generation: number;
  ownerMatchesWinner: boolean;
  terminationEventId: number | null;
  rawAuditAppendCount: number;
};

type ControllerScenario = {
  controller: NodeEventIngressController;
  sent: Array<Record<string, unknown>>;
};

export class OwnerlessStaleTerminalPersistedReplayHarness {
  private readonly ingress: EventIngressRepository;
  private readonly sessionReads: SessionReadRepository;

  constructor(readonly postgres: FullSchemaPostgresHarness) {
    this.ingress = new EventIngressRepository(
      { resolveSql: async () => postgres.sql as unknown as EventIngressSql },
      applyEventSessionEffect,
    );
    this.sessionReads = new SessionReadRepository(
      postgres.sql as ConstructorParameters<typeof SessionReadRepository>[0],
    );
  }

  async observeRejectedStaleTerminal():
  Promise<PersistedStaleTerminalReplayObservation> {
    await this.insertOwnerlessRunning(STALE_SESSION_ID);
    const barrier = deterministicBarrier();
    let application: EventSessionEffectApplication | undefined;
    const scenario = this.createController(STALE_SESSION_ID, async (nodeId, batch) => {
      barrier.reached.resolve(undefined);
      await barrier.release.promise;
      const results = await this.ingress.commitBatch(nodeId, batch);
      application = committedApplication(results);
      return results;
    });

    scenario.controller.enqueue(terminalBatch(
      STALE_SESSION_ID,
      STALE_STREAM_ID,
      "stale-ownerless-terminal-persisted-replay",
    ) as unknown as Record<string, unknown>);
    await barrier.reached.promise;
    const acquire = await this.commitAcquire(STALE_SESSION_ID);
    barrier.release.resolve(undefined);
    await scenario.controller.drain();

    if (!acquire.applied || !application) {
      throw new Error("persisted stale replay fixture did not establish its acquire winner");
    }
    const terminalEventId = await this.terminalEventId(STALE_SESSION_ID);
    const beforeInput = await this.snapshot(STALE_SESSION_ID);
    const replay = await this.replayThroughSessionHistoryRoute(
      STALE_SESSION_ID,
      terminalEventId,
    );
    const nextInput = await this.deliverNextExplicitInput(STALE_SESSION_ID);
    const afterInput = await this.snapshot(STALE_SESSION_ID);
    const ack = ackObservation(scenario.sent);

    return {
      effectApplied: application.applied,
      rawAuditAppendCount: beforeInput.rawAuditAppendCount,
      receiptCount: await this.receiptCount(STALE_SESSION_ID, terminalEventId),
      ackCount: ack.count,
      ackApplied: ack.applied,
      replayStatusCode: replay.statusCode,
      replaySessionEndedCount: replay.sessionEndedCount,
      replayCompletionCount: replay.completionCount,
      canonicalStatusAfterReconnect: beforeInput.status,
      canonicalGenerationAfterReconnect: beforeInput.generation,
      canonicalOwnerMatchesWinnerAfterReconnect: beforeInput.ownerMatchesWinner,
      canonicalTerminationEventIdAfterReconnect: beforeInput.terminationEventId,
      nextInputObservedGeneration: nextInput.observedGeneration,
      nextInputDeliveryCount: nextInput.deliveryCount,
      nextTurnCount: nextInput.turnCount,
      nextModelTurnCount: nextInput.modelTurnCount,
      nextInputAutoResumeCount: nextInput.autoResumeCount,
      generationAfterInput: afterInput.generation,
    };
  }

  async observeAppliedTerminal():
  Promise<PersistedAppliedTerminalReplayObservation> {
    await this.insertOwnerlessRunning(APPLIED_SESSION_ID);
    await this.primeReplayCursor(APPLIED_SESSION_ID);
    let application: EventSessionEffectApplication | undefined;
    const scenario = this.createController(APPLIED_SESSION_ID, async (nodeId, batch) => {
      const results = await this.ingress.commitBatch(nodeId, batch);
      application = committedApplication(results);
      return results;
    });
    scenario.controller.enqueue(terminalBatch(
      APPLIED_SESSION_ID,
      APPLIED_STREAM_ID,
      "applied-ownerless-terminal-persisted-replay",
    ) as unknown as Record<string, unknown>);
    await scenario.controller.drain();
    if (!application) {
      throw new Error("persisted applied replay fixture lacks its terminal application");
    }

    const terminalEventId = await this.terminalEventId(APPLIED_SESSION_ID);
    const snapshot = await this.snapshot(APPLIED_SESSION_ID);
    const replay = await this.replayThroughSessionHistoryRoute(
      APPLIED_SESSION_ID,
      terminalEventId,
    );
    const ack = ackObservation(scenario.sent);
    return {
      effectApplied: application.applied,
      rawAuditAppendCount: snapshot.rawAuditAppendCount,
      receiptCount: await this.receiptCount(APPLIED_SESSION_ID, terminalEventId),
      ackCount: ack.count,
      ackApplied: ack.applied,
      replayStatusCode: replay.statusCode,
      replaySessionEndedCount: replay.sessionEndedCount,
      replayCompletionCount: replay.completionCount,
      canonicalStatus: snapshot.status,
      canonicalTerminationEventId: snapshot.terminationEventId,
    };
  }

  private createController(
    sessionId: string,
    commitBatch: (
      nodeId: string,
      batch: EventAppendBatch,
    ) => Promise<EventIngressResult[]>,
  ): ControllerScenario {
    const registry = new InMemoryNodeRegistry({ nowMs: () => EVENT_AT.getTime() });
    const registration = registry.registerNode({
      type: "node_register",
      node_id: OWNERLESS_NODE_ID,
      user: { email: "ownerless-red@example.com" },
      sessions: [{
        agentSessionId: sessionId,
        session_id: sessionId,
        session_type: "claude",
        caller_source: "browser",
        status: "running",
        execution_generation: 0,
      }],
    });
    const sent: Array<Record<string, unknown>> = [];
    const controller = new NodeEventIngressController({
      nodeId: OWNERLESS_NODE_ID,
      connectionId: registration.node.connectionId,
      committer: { commitBatch },
      isCurrentConnection: () => true,
      receiveCommittedEvent: (message) => registry.receiveNodeMessage(
        { nodeId: OWNERLESS_NODE_ID, connectionId: registration.node.connectionId },
        message,
      ),
      publish: () => undefined,
      send: (frame) => sent.push(frame),
      close: () => undefined,
      logError: () => undefined,
      logWarn: () => undefined,
    });
    return { controller, sent };
  }

  private async commitAcquire(sessionId: string): Promise<EventSessionEffectApplication> {
    const effect: EventOutboxSessionEffect = {
      kind: "execution_acquire",
      owner_kind: LIVE_OWNER_IDENTITY.ownerKind,
      manifest_id: LIVE_OWNER_IDENTITY.manifestId,
      runtime_env_identity: LIVE_OWNER_IDENTITY.runtimeEnvIdentity,
      registration_id: LIVE_OWNER_IDENTITY.registrationId,
      pid: LIVE_OWNER_IDENTITY.pid,
      start_identity: LIVE_OWNER_IDENTITY.startIdentity,
      execution_command_id: LIVE_OWNER_IDENTITY.executionCommandId,
      lease_expires_at: new Date(EVENT_AT.getTime() + 60_000).toISOString(),
      review_state: "not_required",
      updated_at: EVENT_AT.toISOString(),
    };
    const input = buildEventOutboxAppendInput(
      sessionId,
      {
        type: "metadata",
        metadata_type: "execution_ownership_transition",
        value: { transition_id: "stale-terminal-persisted-replay-acquire" },
        timestamp: EVENT_AT,
        _dedupe_key: `stale-terminal-persisted-replay-acquire:${sessionId}`,
      } as never,
      effect,
    );
    const results = await this.ingress.commitBatch(
      OWNERLESS_NODE_ID,
      eventBatch(eventRecord(STALE_ACQUIRE_STREAM_ID, 1, input)),
    );
    return committedApplication(results);
  }

  private async primeReplayCursor(sessionId: string): Promise<void> {
    const input = buildEventOutboxAppendInput(
      sessionId,
      {
        type: "metadata",
        metadata_type: "persisted_replay_cursor",
        value: { fixture: "applied-terminal-control" },
        timestamp: EVENT_AT,
        _dedupe_key: `applied-terminal-persisted-replay-cursor:${sessionId}`,
      } as never,
    );
    await this.ingress.commitBatch(
      OWNERLESS_NODE_ID,
      eventBatch(eventRecord(APPLIED_CURSOR_STREAM_ID, 1, input)),
    );
  }

  private async replayThroughSessionHistoryRoute(
    sessionId: string,
    terminalEventId: number,
  ): Promise<{ statusCode: number; sessionEndedCount: number; completionCount: number }> {
    const repository = createLiveDbCatalogRepository({
      sql: this.postgres.sql as unknown as LivePostgresSql,
    });
    const app = createApp({
      config: {
        environment: "test",
        databaseUrl: "postgresql://test/test",
        authBearerToken: "test-token",
      },
      sessionHistoryRoutes: {
        provider: repository.sessionHistoryProvider,
        closeAfterHistorySync: true,
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/events`,
        headers: { "last-event-id": String(terminalEventId - 1) },
      });
      const frames = parseSseFrames(response.body);
      const sessionEnded = frames.filter((frame) => frame.event === "session_ended");
      return {
        statusCode: response.statusCode,
        sessionEndedCount: sessionEnded.length,
        completionCount: sessionEnded.filter((frame) =>
          isRecord(frame.data)
          && ["completed", "error", "interrupted"].includes(String(frame.data.status)),
        ).length,
      };
    } finally {
      await app.close();
      await repository.close();
    }
  }

  private async deliverNextExplicitInput(sessionId: string): Promise<{
    observedGeneration: number | null;
    deliveryCount: number;
    turnCount: number;
    modelTurnCount: number;
    autoResumeCount: number;
  }> {
    const row = await this.sessionReads.getSession(sessionId);
    if (!row) throw new Error("persisted replay fixture cannot hydrate canonical session");
    const task = hydrateEvictedTaskFromSessionRow(row as unknown as SessionRow, logger);
    if (!task) throw new Error("persisted replay fixture hydration returned null");
    const observedGeneration = task.executionOwnership?.ownershipGeneration ?? null;
    task.runner = {
      engine: {} as never,
      eventPersistence: "runner",
      dispatcher: { hasActiveExecution: () => true },
    } as unknown as Task["runner"];
    let deliveryCount = 0;
    let turnCount = 0;
    let modelTurnCount = 0;
    let autoResumeCount = 0;
    const route = new TaskInterventionRoute({
      getTask: () => task,
      loadEvictedTask: async () => task,
      rememberTask: () => undefined,
      runningInterventionTransition: {
        deliver: async () => {
          deliveryCount += 1;
          turnCount += 1;
          modelTurnCount += 1;
          return { delivered: true };
        },
        queueOnly: async () => {
          throw new Error("persisted reconnect input unexpectedly queued");
        },
      },
      autoResumeTransition: {
        resume: async () => {
          autoResumeCount += 1;
          return { autoResumed: true };
        },
      },
    });
    await route.addIntervention({
      agentSessionId: sessionId,
      text: "continue after persisted replay reconnect",
      user: "ownerless-red-user",
      source: "user_message",
    }, () => {
      autoResumeCount += 1;
    });
    return { observedGeneration, deliveryCount, turnCount, modelTurnCount, autoResumeCount };
  }

  private async insertOwnerlessRunning(sessionId: string): Promise<void> {
    await this.postgres.sql`
      INSERT INTO sessions (
        session_id, session_type, status, agent_id, node_id, review_state
      ) VALUES (
        ${sessionId}, 'claude', 'running', 'agent-ownerless-red',
        ${OWNERLESS_NODE_ID}, 'not_required'
      )
    `;
  }

  private async terminalEventId(sessionId: string): Promise<number> {
    const rows = await this.postgres.sql<Array<{ id: number }>>`
      SELECT id FROM events
      WHERE session_id = ${sessionId} AND event_type = 'session_ended'
      ORDER BY id ASC
    `;
    if (rows.length !== 1 || !Number.isSafeInteger(Number(rows[0]?.id))) {
      throw new Error(`persisted replay fixture expected one raw terminal: ${sessionId}`);
    }
    return Number(rows[0]!.id);
  }

  private async receiptCount(sessionId: string, eventId: number): Promise<number> {
    const rows = await this.postgres.sql<Array<{ count: string | number }>>`
      SELECT COUNT(*)::int AS count FROM event_ingress_receipts
      WHERE session_id = ${sessionId} AND event_id = ${eventId}
    `;
    return Number(rows[0]?.count ?? 0);
  }

  private async snapshot(sessionId: string): Promise<CanonicalSnapshot> {
    const rows = await this.postgres.sql<Array<{
      status: string;
      execution_generation: string | number;
      execution_manifest_id: string | null;
      execution_runtime_env_identity: string | null;
      execution_registration_id: string | null;
      execution_pid: number | null;
      execution_start_identity: string | null;
      execution_command_id: string | null;
      termination_event_id: number | null;
      raw_audit_append_count: string | number;
    }>>`
      SELECT status, execution_generation, execution_manifest_id,
             execution_runtime_env_identity, execution_registration_id,
             execution_pid, execution_start_identity, execution_command_id,
             termination_event_id,
             (
               SELECT COUNT(*)::int FROM events
               WHERE events.session_id = sessions.session_id
                 AND events.event_type = 'session_ended'
             ) AS raw_audit_append_count
      FROM sessions WHERE session_id = ${sessionId}
    `;
    const row = rows[0];
    if (!row) throw new Error(`persisted replay canonical session missing: ${sessionId}`);
    return {
      status: row.status,
      generation: Number(row.execution_generation),
      ownerMatchesWinner:
        row.execution_manifest_id === LIVE_OWNER_IDENTITY.manifestId
        && row.execution_runtime_env_identity === LIVE_OWNER_IDENTITY.runtimeEnvIdentity
        && row.execution_registration_id === LIVE_OWNER_IDENTITY.registrationId
        && row.execution_pid === LIVE_OWNER_IDENTITY.pid
        && row.execution_start_identity === LIVE_OWNER_IDENTITY.startIdentity
        && row.execution_command_id === LIVE_OWNER_IDENTITY.executionCommandId,
      terminationEventId: row.termination_event_id,
      rawAuditAppendCount: Number(row.raw_audit_append_count),
    };
  }
}

function terminalBatch(
  sessionId: string,
  streamId: string,
  semanticKey: string,
): EventAppendBatch {
  const effect: EventOutboxSessionEffect = {
    kind: "terminal_transition",
    status: "error",
    termination_reason: "error_aborted",
    termination_detail: "stale terminal persisted replay fixture",
    review_state: "not_required",
    last_assistant_text: "stale terminal must remain audit-only",
    updated_at: EVENT_AT.toISOString(),
  };
  const input = buildEventOutboxAppendInput(
    sessionId,
    {
      type: "session_ended",
      status: "error",
      termination_reason: "error_aborted",
      termination_detail: "stale terminal persisted replay fixture",
      session_type: "claude",
      caller_source: "browser",
      timestamp: EVENT_AT,
      _dedupe_key: semanticKey,
    } as never,
    effect,
  );
  return eventBatch(eventRecord(streamId, 1, input));
}

function eventRecord(
  streamId: string,
  sourceSeq: number,
  input: ReturnType<typeof buildEventOutboxAppendInput>,
): EventOutboxRecord {
  const unsigned = { stream_id: streamId, source_seq: sourceSeq, ...input };
  return { ...unsigned, payload_hash: computeEventOutboxPayloadHash(unsigned) };
}

function eventBatch(record: EventOutboxRecord): EventAppendBatch {
  return {
    type: "event_append_batch",
    protocol_version: 1,
    stream_id: record.stream_id,
    first_seq: record.source_seq,
    events: [record],
  };
}

function committedApplication(results: EventIngressResult[]): EventSessionEffectApplication {
  const result = results[0];
  if (!result || result.outcome !== "committed" || !result.sessionEffectApplication) {
    throw new Error("persisted replay ingress lacks a session effect application");
  }
  return result.sessionEffectApplication;
}

function ackObservation(sent: Array<Record<string, unknown>>): {
  count: number;
  applied: boolean | null;
} {
  const acks = sent.filter((frame) => frame.type === "event_append_ack") as EventAppendAck[];
  return {
    count: acks.length,
    applied: acks.at(-1)?.events[0]?.effect_application?.applied ?? null,
  };
}

function parseSseFrames(body: string): Array<{ event: string; data: unknown }> {
  return body.split("\n\n").flatMap((block) => {
    const event = block.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
    const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    if (!event || data === undefined) return [];
    try {
      return [{ event, data: JSON.parse(data) as unknown }];
    } catch {
      return [{ event, data }];
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deterministicBarrier(): { reached: Deferred<void>; release: Deferred<void> } {
  return { reached: deferred<void>(), release: deferred<void>() };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
