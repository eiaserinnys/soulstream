import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CompletedParentS5FullSliceHarness,
  type SseFrame,
} from "./completed_parent_child_completion_full_slice_harness.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres =
  hasFullSchemaPostgresBackend || hasDockerBinary() ? describe : describe.skip;

describePostgres("S5 completed-parent child-completion full slice", () => {
  let postgres: FullSchemaPostgresHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
  }, 45_000);

  afterAll(async () => {
    await postgres?.cleanup();
  });

  it("threads one completion correlation through ownership, consume, and Fastify catch-up", async () => {
    const harness = await CompletedParentS5FullSliceHarness.create(postgres);
    try {
      const active = await harness.notifyToActivation();

      expect(active.startBoundary).toEqual({
        deliveryId: active.correlationId,
        taskStatus: "initializing",
        activationAttached: true,
      });
      expect(active.ownership).toMatchObject({
        status: "running",
        execution_generation: 1,
        execution_manifest_id: "in-process:codex",
        execution_runtime_env_identity: "in-process:codex:p0cn-s5-parent-agent",
        execution_registration_id: expect.any(String),
        execution_pid: process.pid,
        execution_start_identity: expect.any(String),
        execution_command_id: expect.any(String),
        termination_event_id: null,
      });
      expect(active.input).toMatchObject({
        inputUuid: active.expectedInputUuid,
        turnOrigin: { kind: "completion_notification" },
      });
      expect(active.input?.prompt).toContain("S5 child completed result");

      const settled = await harness.finish();
      expect(settled.delivery).toMatchObject({
        delivery_id: active.correlationId,
        relation_key: active.relationKey,
        state: "consumed",
        aggregate_state: "consumed",
        attempt_count: 0,
        last_error: null,
      });
      expect(settled.notificationReceipt).toMatchObject({
        state: "published",
        target_receipt_id: `event:${settled.notificationEvent.id}`,
      });
      expect(settled.notificationEvent.payload).toMatchObject({
        type: "session_notification",
        delivery_id: active.correlationId,
        relation_key: active.relationKey,
        disposition: "auto_resume",
      });
      expect(settled.relationConsumption).toMatchObject({
        relation_key: active.relationKey,
        caller_session_id: "p0cn-s5-parent",
        consumed_turn_id: expect.stringMatching(/^event:\d+$/),
      });
      expect(settled.notificationEvent.id).toBeLessThan(settled.acquireEventId);
      expect(settled.acquireEventId).toBeLessThan(settled.assistantEvent.id);
      expect(settled.finalSession).toMatchObject({
        status: "completed",
        execution_generation: 1,
        execution_manifest_id: null,
        execution_runtime_env_identity: null,
        execution_registration_id: null,
        execution_pid: null,
        execution_start_identity: null,
        execution_command_id: null,
        termination_event_id: expect.any(Number),
      });

      expect(settled.catchupStatusCode).toBe(200);
      expect(catchupPayload(settled.catchupFrames, "session_notification")).toMatchObject({
        delivery_id: active.correlationId,
        relation_key: active.relationKey,
        disposition: "auto_resume",
      });
      expect(catchupPayload(settled.catchupFrames, "assistant_message")).toMatchObject({
        content: "S5 parent consumed the correlated child completion",
      });
      expect(settled.catchupFrames.map((frame) => frame.event)).toEqual(
        expect.arrayContaining(["session_notification", "assistant_message", "session_ended", "history_sync"]),
      );
      expect(settled.catchupFrames.filter(
        (frame) => frame.event === "assistant_message",
      )).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  }, 45_000);
});

function catchupPayload(
  frames: readonly SseFrame[],
  event: string,
): Record<string, unknown> | undefined {
  return frames.find((frame) => frame.event === event)?.data;
}

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
