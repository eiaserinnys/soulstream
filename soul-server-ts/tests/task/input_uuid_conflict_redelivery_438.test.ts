import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import { ExecutionContextBuilder } from "../../src/context/context_builder.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import { ClaudeEngineAdapter, ClaudeSdkClient } from "../../src/engine/claude_adapter.js";
import { ClaudeSessionClientRegistry } from "../../src/engine/claude_session_client_registry.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { deliveryRowToInterventionParams, redeliverStoredDeliveryContent } from "../../src/task/delivery_row_intervention.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from "../../src/task/task_running_intervention_transition.js";
import { makeHarness, sdkInit, sdkResult } from "../engine/claude_sdk_persistent_test_harness.js";
import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const logger = pino({ level: "silent" });

/**
 * Reuses the persistent SDK and event-persistence harnesses. Only external DB
 * reads and the SDK transport are doubles; prompt assembly, durable-row replay,
 * public intervention routing, executor and Claude admission are production code.
 * No direct enqueue calls or fabricated second prompt/hash seed the conflict.
 */
describe("#438 same durable delivery across resume and startup redelivery", () => {
  it("keeps a completed first delivery from turning its session into error_aborted", async () => {
    const sdk = makeHarness();
    const client = new ClaudeSdkClient({ query: sdk.queryFn }, logger);
    const registry = new ClaudeSessionClientRegistry(
      () => client, { idleTtlMs: 300_000, maxEntries: 4 },
    );
    const agent: AgentProfile = {
      id: "uuid-conflict-438", name: "UUID conflict regression",
      backend: "claude", workspace_dir: "/tmp/uuid-conflict-438",
    };
    const callerInfo = { source: "agent", agent_id: "sender", agent_node: "node-a" };
    const task: Task = {
      agentSessionId: "uuid-conflict-target", profileId: agent.id,
      prompt: "previous request", status: "completed",
      createdAt: new Date("2026-10-16T08:00:00.000Z"),
      lastEventId: 7, lastReadEventId: 7, terminalEventId: 7,
      interventionQueue: [], codexThreadId: "old-backend-session",
      lastInjectedClaudeSessionId: "older-backend-session",
      callerInfo: { source: "browser", user_id: "human" },
      lastInjectedCallerInfo: { source: "browser", user_id: "human" },
    };
    const events: SSEEventPayload[] = [];
    const persistence = makeEventPersistenceTestDouble();
    const broadcaster = {
      emitEventEnvelope: vi.fn(async (_id: string, event: SSEEventPayload) => {
        events.push(event);
      }),
      emitSessionUpdated: vi.fn(), emitCatalogUpdated: vi.fn(),
    };
    const db = {
      getAssignedCardContext: vi.fn(async () => ({
        total: 1, omitted: 0, capturedAt: "2026-10-16T09:01:00.000Z",
        cards: [{ id: "assigned-card", title: "Current work", status: "running",
          hasItems: true, latestCommentAt: null, latestReportAt: null }],
      })),
      listRunningSessionsSummary: vi.fn(async () => ({ total: 0, sessions: [] })),
      getSession: vi.fn(async () => null),
    } as unknown as SessionDB;
    const context = new ExecutionContextBuilder(db, {} as AgentRegistry, {
      nodeId: "node-a", atom: { enabled: false, serverUrl: "", apiKey: "" },
    }, logger);
    const engine = new ClaudeEngineAdapter({
      workspaceDir: agent.workspace_dir, agentId: agent.id, client,
      processEnv: {}, persistentSessionRegistry: registry,
    }, logger);
    const executeInputs: Array<{ prompt: string; inputUuid?: string }> = [];
    const executeToFrameChannel = engine.executeToFrameChannel.bind(engine);
    vi.spyOn(engine, "executeToFrameChannel").mockImplementation((input, channel) => {
      executeInputs.push({ prompt: input.prompt, inputUuid: input.inputUuid });
      return executeToFrameChannel(input, channel);
    });
    const inject = vi.spyOn(engine, "injectAtToolBoundary");
    const executor = new TaskExecutor(
      () => engine, db, persistence.persistence, broadcaster as never, logger, context,
    );
    const running = new RunningInterventionTransition({
      broadcaster: broadcaster as never, logger, persistence: persistence.persistence,
      assignedCardContext: (current, inputId) => context.buildAssignedCardContext(current, inputId),
    });
    const route = new TaskInterventionRoute({
      getTask: () => task, loadEvictedTask: vi.fn(async () => null), rememberTask: vi.fn(),
      runningInterventionTransition: running,
      autoResumeTransition: new AutoResumeTransition({ logger, persistence: persistence.persistence }),
    });
    // Same durable row is observed once by the sender and once by startup replay.
    // Attempt tokens are transport ownership only; payload is unchanged.
    const row = {
      delivery_id: "delivery-438", target_session_id: task.agentSessionId,
      source: "user_message", intent: "human_live_steer", relation_key: "delivery-438",
      caller_turn_id: null, target_receipt_id: null, delivered_at: null,
      attempt_token: "first-attempt", created_at: new Date("2026-10-16T09:01:00.000Z"),
      payload_hash: "canonical-row-hash",
      payload: { text: "Deployment finished; continue the pending work.", user: "sender",
        caller_info: callerInfo },
    } as unknown as SessionDeliveryRow;
    let execution: Promise<void> | undefined;
    const onResume = (current: Task, activation?: Task["executionActivation"]) => {
      execution = executor.startNewExecution(current, agent, activation);
      void execution.catch(() => undefined);
    };
    try {
      await expect(route.addIntervention(deliveryRowToInterventionParams(row), onResume))
        .resolves.toEqual({ autoResumed: true });
      const first = await sdk.nextInput();
      expect(first.uuid).toBe(buildDeliveryInputUuid(row.delivery_id));
      const firstPrompt = first.message.content as string;
      expect(firstPrompt).toContain("<running_sessions>");
      expect(firstPrompt).toContain("<caller_info_update>");
      sdk.push(sdkInit("backend-438"));

      await redeliverStoredDeliveryContent({ ...row, attempt_token: "startup-attempt" }, route, onResume);
      const queuedAfterRedelivery = task.interventionQueue.map(message => message.deliveryId);

      // First input really finishes. Only its queued replay now takes the next turn.
      sdk.push(sdkResult("backend-438", first.uuid, "first delivery handled"));
      await execution;
      const observed = {
        status: task.status, terminationReason: task.terminationReason,
        error: task.error,
        executeCount: executeInputs.length,
        sameUuid: executeInputs.every(input => input.inputUuid === first.uuid),
        firstHasCallerUpdate: firstPrompt.includes("<caller_info_update>"),
        replayHasCallerUpdate: executeInputs[1]?.prompt.includes("<caller_info_update>"),
        injectionHasRunningSessions: inject.mock.calls[0]?.[0].prompt.includes("<running_sessions>"),
        queuedAfterRedelivery,
        terminalEvents: persistence.enqueueEvent.mock.calls
          .map(([, event]) => event).filter(event => event.type === "session_ended"),
      };
      process.stdout.write(`UUID_CONFLICT_438 ${JSON.stringify(observed)}\n`);
      // Regression assertion: RED includes the real error terminal event and reason.
      expect(observed, JSON.stringify(observed)).toMatchObject({
        status: "completed", terminationReason: "completed_ok", error: undefined,
      });
    } finally {
      sdk.end();
      await client.close();
    }
  }, 60_000);
});
