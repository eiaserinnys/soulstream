import pino from "pino";

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
import {
  InMemoryNodeRegistry,
  type NodeRegistryEvent,
} from "../../../orch-server-ts/src/node/registry.js";
import { PushNotifier, SessionForegroundObserverTracker } from
  "../../../orch-server-ts/src/push/push_notifier.js";
import {
  RuntimeSessionEventHub,
  createRuntimeSessionEventHubSink,
} from "../../../orch-server-ts/src/runtime/session_event_hub.js";
import {
  buildEventOutboxAppendInput,
} from "../../src/db/event_persistence.js";
import type { SessionRow } from "../../src/db/session_db.js";
import {
  computeEventOutboxPayloadHash,
  type EventOutboxRecord,
  type EventOutboxSessionEffect,
} from "../../src/upstream/event_outbox.js";
import { hydrateEvictedTaskFromSessionRow } from
  "../../src/task/task_evicted_hydration.js";
import { TaskInterventionRoute } from
  "../../src/task/task_intervention_route.js";
import type { Task } from "../../src/task/task_models.js";
import type { FullSchemaPostgresHarness } from
  "../db/full_schema_postgres_harness.js";
import {
  LIVE_OWNER_IDENTITY,
  OWNERLESS_NODE_ID,
} from "./ownerless_running_reconciliation_fixture.js";
import type {
  AppliedTerminalFanoutObservation,
  StaleTerminalFanoutObservation,
} from "./ownerless_stale_terminal_fanout_oracle.js";

const STALE_STREAM_ID = "00000000-0000-4000-8000-000000000301";
const STALE_ACQUIRE_STREAM_ID = "00000000-0000-4000-8000-000000000302";
const APPLIED_STREAM_ID = "00000000-0000-4000-8000-000000000303";
const EVENT_AT = new Date("2026-08-28T05:00:00.000Z");
const logger = pino({ level: "silent" });

type CanonicalSnapshot = {
  status: string;
  generation: number;
  ownerMatchesWinner: boolean;
  terminationEventId: number | null;
  rawAuditAppendCount: number;
};

type FanoutCounters = {
  rawTerminalRegistryEventCount: number;
  pushSendCount: number;
  semanticTerminalNotificationCount: number;
  runtimeTerminalDeliveryCount: number;
  callerCompletionCount: number;
  modelCompletionCount: number;
};

export class OwnerlessStaleTerminalFanoutHarness {
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

  async observeRejectedStaleTerminal(): Promise<StaleTerminalFanoutObservation> {
    const sessionId = "ownerless-row2-stale-terminal-fanout";
    await this.insertOwnerlessRunning(sessionId);
    const barrier = deterministicBarrier();
    let terminalApplication: EventSessionEffectApplication | undefined;
    const scenario = this.composeFanout(sessionId, async (nodeId, batch) => {
      barrier.reached.resolve(undefined);
      await barrier.release.promise;
      const results = await this.ingress.commitBatch(nodeId, batch);
      terminalApplication = committedApplication(results);
      return results;
    });

    scenario.controller.enqueue(terminalBatch(
      sessionId,
      STALE_STREAM_ID,
      "stale-ownerless-terminal",
    ) as unknown as Record<string, unknown>);
    await barrier.reached.promise;
    const acquireApplication = await this.commitAcquire(sessionId);
    barrier.release.resolve(undefined);
    await scenario.controller.drain();
    await scenario.notifier.flush();

    if (!acquireApplication.applied) {
      throw new Error("stale terminal fanout fixture failed to install acquire winner");
    }
    if (!terminalApplication) {
      throw new Error("stale terminal fanout fixture lacks terminal application");
    }
    const beforeInputTerminalDeliveries = scenario.counters.runtimeTerminalDeliveryCount;
    const input = await this.deliverNextExplicitInput(sessionId);
    const snapshot = await this.snapshot(sessionId);
    const observation: StaleTerminalFanoutObservation = {
      effectApplied: terminalApplication.applied,
      ackApplied: ackApplication(scenario.sent),
      rawAuditAppendCount: snapshot.rawAuditAppendCount,
      rawTerminalRegistryEventCount: scenario.counters.rawTerminalRegistryEventCount,
      pushSendCount: scenario.counters.pushSendCount,
      semanticTerminalNotificationCount:
        scenario.counters.semanticTerminalNotificationCount,
      runtimeTerminalDeliveryCount: scenario.counters.runtimeTerminalDeliveryCount,
      callerEarlyCompletionCount: scenario.counters.callerCompletionCount,
      modelEarlyCompletionCount: scenario.counters.modelCompletionCount,
      canonicalStatus: snapshot.status,
      canonicalGeneration: snapshot.generation,
      canonicalOwnerMatchesWinner: snapshot.ownerMatchesWinner,
      canonicalTerminationEventId: snapshot.terminationEventId,
      cacheStatus: scenario.cacheStatus(),
      nextInputObservedGeneration: input.observedGeneration,
      nextInputDeliveryCount: input.deliveryCount,
      nextTurnCount: input.turnCount,
      nextModelTurnCount: input.modelTurnCount,
      nextInputAutoResumeCount: input.autoResumeCount,
      generationAfterInput: snapshot.generation,
      hiddenCompletionAfterInputCount:
        scenario.counters.runtimeTerminalDeliveryCount - beforeInputTerminalDeliveries,
    };
    await scenario.notifier.close();
    return observation;
  }

  async observeAppliedTerminal(): Promise<AppliedTerminalFanoutObservation> {
    const sessionId = "ownerless-row2-applied-terminal-fanout";
    await this.insertOwnerlessRunning(sessionId);
    let terminalApplication: EventSessionEffectApplication | undefined;
    const scenario = this.composeFanout(sessionId, async (nodeId, batch) => {
      const results = await this.ingress.commitBatch(nodeId, batch);
      terminalApplication = committedApplication(results);
      return results;
    });
    scenario.controller.enqueue(terminalBatch(
      sessionId,
      APPLIED_STREAM_ID,
      "applied-ownerless-terminal",
    ) as unknown as Record<string, unknown>);
    await scenario.controller.drain();
    await scenario.notifier.flush();
    if (!terminalApplication) {
      throw new Error("applied terminal fanout fixture lacks terminal application");
    }
    const snapshot = await this.snapshot(sessionId);
    const observation: AppliedTerminalFanoutObservation = {
      effectApplied: terminalApplication.applied,
      ackApplied: ackApplication(scenario.sent),
      rawAuditAppendCount: snapshot.rawAuditAppendCount,
      ...scenario.counters,
      callerCompletionCount: scenario.counters.callerCompletionCount,
      modelCompletionCount: scenario.counters.modelCompletionCount,
      canonicalStatus: snapshot.status,
      cacheStatus: scenario.cacheStatus(),
      canonicalTerminationEventId: snapshot.terminationEventId,
    };
    await scenario.notifier.close();
    return observation;
  }

  private composeFanout(
    sessionId: string,
    commitBatch: (
      nodeId: string,
      batch: EventAppendBatch,
    ) => Promise<EventIngressResult[]>,
  ): {
    controller: NodeEventIngressController;
    notifier: PushNotifier;
    counters: FanoutCounters;
    sent: Array<Record<string, unknown>>;
    cacheStatus(): string | null;
  } {
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
    const counters: FanoutCounters = {
      rawTerminalRegistryEventCount: 0,
      pushSendCount: 0,
      semanticTerminalNotificationCount: 0,
      runtimeTerminalDeliveryCount: 0,
      callerCompletionCount: 0,
      modelCompletionCount: 0,
    };
    const hub = new RuntimeSessionEventHub();
    hub.subscribe(sessionId, (event) => {
      if (!isSessionEndedEnvelope(event.data)) return;
      counters.runtimeTerminalDeliveryCount += 1;
      counters.callerCompletionCount += 1;
      counters.modelCompletionCount += 1;
    });
    const hubSink = createRuntimeSessionEventHubSink(hub);
    const notifier = new PushNotifier({
      provider: {
        send: async () => {
          counters.pushSendCount += 1;
          return { ok: true, invalidToken: false };
        },
      },
      repository: {
        upsertToken: async () => undefined,
        listTokens: async () => [{ deviceId: "device-ownerless", expoToken: "token-ownerless" }],
        deleteToken: async () => undefined,
      },
      catalog: {
        findSessionFolderId: () => null,
        listFolders: () => [],
      },
      sessionLookup: (id) => registry.sessionCache.findSession(id)?.payload,
      resolveNodeEmail: () => "ownerless-red@example.com",
      foregroundObservers: new SessionForegroundObserverTracker(),
      onInfo: (event) => {
        if (event.action === "sent" && event.notification_kind === "session_ended") {
          counters.semanticTerminalNotificationCount += 1;
        }
      },
      onWarning: () => undefined,
      nowMs: () => EVENT_AT.getTime(),
    });
    const sent: Array<Record<string, unknown>> = [];
    const publish = (events: NodeRegistryEvent[]): void => {
      for (const event of events) {
        if (event.type === "node_session_event" && isSessionEndedEnvelope(event.data)) {
          counters.rawTerminalRegistryEventCount += 1;
        }
      }
      hubSink(events);
      notifier.accept(events);
    };
    const controller = new NodeEventIngressController({
      nodeId: OWNERLESS_NODE_ID,
      connectionId: registration.node.connectionId,
      committer: { commitBatch },
      isCurrentConnection: () => true,
      receiveCommittedEvent: (message) => registry.receiveNodeMessage(
        { nodeId: OWNERLESS_NODE_ID, connectionId: registration.node.connectionId },
        message,
      ),
      publish,
      send: (frame) => sent.push(frame),
      close: () => undefined,
      logError: () => undefined,
      logWarn: () => undefined,
    });
    return {
      controller,
      notifier,
      counters,
      sent,
      cacheStatus: () => registry.sessionCache.findSession(sessionId)?.status ?? null,
    };
  }

  private async commitAcquire(
    sessionId: string,
  ): Promise<EventSessionEffectApplication> {
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
        value: { transition_id: "stale-terminal-fanout-acquire" },
        timestamp: EVENT_AT,
        _dedupe_key: `stale-terminal-fanout-acquire:${sessionId}`,
      } as never,
      effect,
    );
    const record = eventRecord(STALE_ACQUIRE_STREAM_ID, 1, input);
    const results = await this.ingress.commitBatch(
      OWNERLESS_NODE_ID,
      eventBatch(record),
    );
    return committedApplication(results);
  }

  private async deliverNextExplicitInput(sessionId: string): Promise<{
    observedGeneration: number | null;
    deliveryCount: number;
    turnCount: number;
    modelTurnCount: number;
    autoResumeCount: number;
  }> {
    const row = await this.sessionReads.getSession(sessionId);
    if (!row) throw new Error("next-input fixture cannot hydrate canonical session");
    const task = hydrateEvictedTaskFromSessionRow(
      row as unknown as SessionRow,
      logger,
    );
    if (!task) throw new Error("next-input fixture hydration returned null");
    const observedGeneration = task.executionOwnership?.ownershipGeneration ?? null;
    task.runner = {
      engine: {} as never,
      eventPersistence: "runner",
      dispatcher: {
        hasActiveExecution: () => true,
      },
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
          throw new Error("current generation input unexpectedly queued");
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
      text: "continue on the winning generation",
      user: "ownerless-red-user",
      source: "user_message",
    }, () => {
      autoResumeCount += 1;
    });
    return {
      observedGeneration,
      deliveryCount,
      turnCount,
      modelTurnCount,
      autoResumeCount,
    };
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
      FROM sessions
      WHERE session_id = ${sessionId}
    `;
    const row = rows[0];
    if (!row) throw new Error(`canonical session missing: ${sessionId}`);
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
    termination_detail: "stale ownerless terminal fanout fixture",
    review_state: "not_required",
    last_assistant_text: "stale terminal must not escape",
    updated_at: EVENT_AT.toISOString(),
  };
  const input = buildEventOutboxAppendInput(
    sessionId,
    {
      type: "session_ended",
      status: "error",
      termination_reason: "error_aborted",
      termination_detail: "stale ownerless terminal fanout fixture",
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

function committedApplication(
  results: EventIngressResult[],
): EventSessionEffectApplication {
  const result = results[0];
  if (!result || result.outcome !== "committed" || !result.sessionEffectApplication) {
    throw new Error("event ingress did not return a session effect application");
  }
  return result.sessionEffectApplication;
}

function ackApplication(sent: Array<Record<string, unknown>>): boolean | null {
  const ack = sent.findLast((frame) => frame.type === "event_append_ack") as
    | EventAppendAck
    | undefined;
  return ack?.events[0]?.effect_application?.applied ?? null;
}

function isSessionEndedEnvelope(data: Record<string, unknown>): boolean {
  const event = data.event;
  return typeof event === "object" && event !== null && !Array.isArray(event)
    && (event as Record<string, unknown>).type === "session_ended";
}

function deterministicBarrier(): {
  reached: Deferred<void>;
  release: Deferred<void>;
} {
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
