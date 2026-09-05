import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ClaudeBackgroundTaskRepository,
  type ObserveClaudeBackgroundTaskGenerationParams,
} from "../../../orch-server-ts/src/control_plane/repositories/claude_background_task_repository.js";
import { SessionDeliveryRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import type { RegisterSessionDeliveryParams } from
  "../../../orch-server-ts/src/control_plane/control_plane_types.js";
import type { SqlClient } from "../../src/db/session_db.js";
import { buildClaudeBackgroundGenerationIdentity } from
  "../../src/task/claude_background_generation_identity.js";
import { buildDeterministicDeliveryIdentity } from
  "../../src/task/delivery_identity.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres =
  hasFullSchemaPostgresBackend || hasDockerBinary() ? describe : describe.skip;

describePostgres("Claude background generation PostgreSQL contract", () => {
  let harness: FullSchemaPostgresHarness;
  let repository: ClaudeBackgroundTaskRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    repository = new ClaudeBackgroundTaskRepository(harness.sql);
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_notification_outbox`;
    await harness.sql`DELETE FROM session_delivery_relation_consumptions`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM claude_background_task_generations`;
    await harness.sql`DELETE FROM claude_background_tasks`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, session_type, status, agent_id)
      VALUES ('caller-session', 'claude', 'running', 'worker')
    `;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("keeps generations side by side and never lets stale A terminalize B projection", async () => {
    const a = generation("toolu-A");
    const b = generation("toolu-B");
    await repository.observeGeneration(a);
    await repository.observeGeneration(b);

    await expect(repository.terminalizeGeneration(terminal(a, "stopped", "10")))
      .resolves.toMatchObject({ accepted: true });
    await expect(repository.get("node-test", "caller-session", "shared-task"))
      .resolves.toMatchObject({ status: "running", tool_use_id: "toolu-B" });

    await expect(repository.terminalizeGeneration(terminal(a, "killed", "11")))
      .resolves.toMatchObject({ accepted: false });
    await expect(repository.terminalizeGeneration(terminal(b, "completed", "20")))
      .resolves.toMatchObject({ accepted: true });

    const rows = await harness.sql<Array<{
      initiating_tool_use_id: string;
      status: string;
    }>>`
      SELECT initiating_tool_use_id, status
      FROM claude_background_task_generations
      ORDER BY generation_sequence
    `;
    expect(rows).toEqual([
      { initiating_tool_use_id: "toolu-A", status: "stopped" },
      { initiating_tool_use_id: "toolu-B", status: "completed" },
    ]);
    await expect(repository.get("node-test", "caller-session", "shared-task"))
      .resolves.toMatchObject({ status: "completed", tool_use_id: "toolu-B" });
    await expect(harness.sql`
      SELECT COUNT(*)::int AS count FROM session_deliveries
    `).resolves.toEqual([{ count: 2 }]);
  });

  it("rolls sidecar and legacy projection back when delivery registration fails", async () => {
    const input = generation("toolu-atomic");
    await repository.observeGeneration(input);
    await harness.sql.unsafe(`
      CREATE OR REPLACE FUNCTION reject_generation_delivery()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected generation delivery failure';
      END;
      $$;
      CREATE TRIGGER reject_generation_delivery_insert
      BEFORE INSERT ON session_deliveries
      FOR EACH ROW EXECUTE FUNCTION reject_generation_delivery();
    `);

    await expect(repository.terminalizeGeneration(
      terminal(input, "completed", "30"),
    )).rejects.toThrow("injected generation delivery failure");
    await expect(repository.getGeneration(
      input.sourceNode,
      input.sessionId,
      input.sdkSessionId,
      input.taskId,
      input.initiatingToolUseId,
    )).resolves.toMatchObject({ status: "running", notification_delivery_id: null });
    await expect(repository.get("node-test", "caller-session", "shared-task"))
      .resolves.toMatchObject({ status: "running", notification_delivery_id: null });
    await harness.sql`
      DROP TRIGGER reject_generation_delivery_insert ON session_deliveries
    `;
  });

  it("resolves TaskOutput only when exactly one unconsumed generation remains", async () => {
    const a = generation("toolu-A");
    const b = generation("toolu-B");
    await expect(repository.resolveGeneration(
      a.sourceNode, a.sessionId, a.sdkSessionId, a.taskId,
    )).resolves.toEqual({ status: "absent" });
    await repository.observeGeneration(a);
    await repository.observeGeneration(b);
    await expect(repository.resolveGeneration(
      a.sourceNode, a.sessionId, a.sdkSessionId, a.taskId,
    )).resolves.toEqual({ status: "ambiguous" });

    await new SessionDeliveryRepository(harness.sql).recordRelationConsumed({
      relationKey: a.relationKey,
      completionId: a.completionId,
      callerSessionId: a.sessionId,
      consumedTurnId: "event:proof-A",
    });
    await expect(repository.resolveGeneration(
      b.sourceNode, b.sessionId, b.sdkSessionId, b.taskId,
    )).resolves.toMatchObject({
      status: "resolved",
      row: { initiating_tool_use_id: "toolu-B" },
    });
  });

  it("registers a terminal delivery already consumed when exact proof arrived first", async () => {
    const input = generation("toolu-preconsumed");
    await new SessionDeliveryRepository(harness.sql).recordRelationConsumed({
      relationKey: input.relationKey,
      completionId: input.completionId,
      callerSessionId: input.sessionId,
      consumedTurnId: "event:preterminal-proof",
    });

    const result = await repository.terminalizeGeneration(
      terminal(input, "completed", "40"),
    );
    expect(result).toMatchObject({
      accepted: true,
      delivery: {
        state: "consumed",
        aggregate_state: "consumed",
        consumed_reason: "relation already consumed",
        target_receipt_id: "event:preterminal-proof",
      },
    });
  });

  it("consumes an already queued runtime delivery when exact proof arrives later", async () => {
    const input = generation("toolu-register-first");
    const delivery = generationDelivery(input, "register-first");
    const deliveries = new SessionDeliveryRepository(harness.sql);
    await deliveries.register(delivery);
    await deliveries.claimAttemptForTarget(
      delivery.deliveryId,
      input.sessionId,
      "attempt-register-first",
    );
    await deliveries.markQueued(delivery.deliveryId, "attempt-register-first");

    await deliveries.recordRelationConsumed({
      relationKey: input.relationKey,
      completionId: input.completionId,
      callerSessionId: input.sessionId,
      consumedTurnId: "event:post-registration-proof",
    });
    await expect(deliveries.get(delivery.deliveryId)).resolves.toMatchObject({
      state: "consumed",
      aggregate_state: "consumed",
      consumed_reason: "exact relation receipt",
      target_receipt_id: "event:post-registration-proof",
    });
  });

  it("rejects malformed runtime delivery identity instead of entering generic registration", async () => {
    const input = generation("toolu-malformed");
    const delivery = generationDelivery(input, "malformed");
    await expect(new SessionDeliveryRepository(harness.sql).register({
      ...delivery,
      payload: { text: "missing runtime identity fields" },
    })).rejects.toThrow("runtime_followup requires payload.followup_key");
    await expect(harness.sql`
      SELECT COUNT(*)::int AS count FROM session_deliveries
    `).resolves.toEqual([{ count: 0 }]);
  });

  it("keeps exact old-worker SQL and PK operational while exposing its terminal collision loss", async () => {
    const oldA = {
      sourceNode: "node-test",
      sessionId: "caller-session",
      sdkSessionId: "sdk-session",
      taskId: "shared-task",
      toolUseId: "toolu-old-A",
    };
    await repository.observe(oldA);
    await expect(repository.terminalize({
      ...oldA,
      status: "completed",
      closeReason: "sdk_completed",
      terminalRevision: "old-A",
      delivery: legacyDelivery("old-A"),
    })).resolves.toMatchObject({ accepted: true });

    const newB = generation("toolu-new-B");
    await repository.observeGeneration(newB);
    await expect(repository.observe({
      ...oldA,
      toolUseId: "toolu-new-B",
    })).resolves.toMatchObject({
      status: "completed",
      tool_use_id: "toolu-old-A",
    });
    await expect(repository.terminalize({
      ...oldA,
      toolUseId: "toolu-new-B",
      status: "completed",
      closeReason: "sdk_completed",
      terminalRevision: "old-worker-B",
      delivery: legacyDelivery("old-worker-B"),
    })).resolves.toMatchObject({ accepted: false });

    await expect(repository.terminalizeGeneration(
      terminal(newB, "completed", "new-worker-B"),
    )).resolves.toMatchObject({ accepted: true });
    await expect(repository.get("node-test", "caller-session", "shared-task"))
      .resolves.toMatchObject({
        status: "completed",
        tool_use_id: "toolu-old-A",
        terminal_revision: "old-A",
      });
    await expect(repository.getGeneration(
      newB.sourceNode,
      newB.sessionId,
      newB.sdkSessionId,
      newB.taskId,
      newB.initiatingToolUseId,
    )).resolves.toMatchObject({
      status: "completed",
      terminal_revision: "new-worker-B",
    });
  });
});

function generation(
  initiatingToolUseId: string,
): ObserveClaudeBackgroundTaskGenerationParams {
  const base = {
    sourceNode: "node-test",
    sessionId: "caller-session",
    sdkSessionId: "sdk-session",
    taskId: "shared-task",
    initiatingToolUseId,
  };
  return {
    ...base,
    ...buildClaudeBackgroundGenerationIdentity({
      ...base,
      agentSessionId: base.sessionId,
      sdkTaskId: base.taskId,
    }),
    status: "running",
    description: `generation ${initiatingToolUseId}`,
  };
}

function terminal(
  input: ObserveClaudeBackgroundTaskGenerationParams,
  status: "completed" | "failed" | "stopped" | "killed",
  terminalRevision: string,
) {
  return {
    ...input,
    status,
    closeReason: `sdk_${status}`,
    terminalRevision,
    delivery: generationDelivery(input, terminalRevision),
  };
}

function generationDelivery(
  input: ObserveClaudeBackgroundTaskGenerationParams,
  terminalRevision: string,
): RegisterSessionDeliveryParams {
  return {
    deliveryId: buildClaudeBackgroundGenerationIdentity({
      sourceNode: input.sourceNode,
      agentSessionId: input.sessionId,
      sdkSessionId: input.sdkSessionId,
      sdkTaskId: input.taskId,
      initiatingToolUseId: input.initiatingToolUseId,
    }).deliveryId,
    targetSessionId: input.sessionId,
    relationKey: input.relationKey,
    completionId: input.completionId,
    intent: "runtime_followup",
    source: "claude_runtime_task_followup",
    producerKind: "claude_background_task",
    producerId: input.taskId,
    producerTerminalRevision: terminalRevision,
    payloadHash: `hash:${input.generationKey}:${terminalRevision}`,
    payload: {
      text: `result ${input.initiatingToolUseId}`,
      user: "system",
      source: "claude_runtime_task_followup",
      followup_key: `${input.sessionId}:${input.generationKey}`,
      followup_attempt: 1,
    },
  };
}

function legacyDelivery(revision: string): RegisterSessionDeliveryParams {
  const relationKey = `legacy:${revision}`;
  const identity = buildDeterministicDeliveryIdentity({
    targetSessionId: "caller-session",
    relationKey,
    intent: "runtime_followup",
  });
  return {
    deliveryId: identity.deliveryId,
    targetSessionId: "caller-session",
    relationKey,
    completionId: identity.completionId,
    intent: "runtime_followup",
    source: "claude_runtime_task_followup",
    producerKind: "claude_background_task",
    producerId: "shared-task",
    producerTerminalRevision: revision,
    payloadHash: `legacy-hash:${revision}`,
    payload: {
      text: revision,
      followup_key: `legacy:${revision}`,
      followup_attempt: 1,
    },
  };
}

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
