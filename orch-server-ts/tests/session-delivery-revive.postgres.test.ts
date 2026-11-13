/**
 * card #1315 — 보낸 쪽이 되살린 죽은 완료 알림 행은 알림 outbox 행이 남아 있어도
 * 다시 claim, dispatch, stage까지 가고 outbox가 새 시도로 claimed가 된다.
 *
 * 죽은 행에는 outbox 행이 dead_letter/discarded(markUncertain이 discard)로 남거나,
 * 받은 쪽이 published한 뒤 소비 없이 끝났다면 published로 남는다. 되살림이 이를
 * 정리하지 않으면 stageWithQueuedDelivery가 "notification outbox already exists"로
 * 막혀 아무도 다시 claim하지 않는다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { SessionDeliveryRepository } from
  "../src/control_plane/repositories/session_delivery_repository.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";

describe("session delivery revival over PostgreSQL", () => {
  let harness: FullSchemaPostgresHarness;
  let repository: SessionDeliveryRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    repository = new SessionDeliveryRepository(harness.sql as unknown as SqlClient);
  }, 60_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_notification_outbox`;
    await harness.sql`DELETE FROM session_delivery_relation_consumptions`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, session_type, status, agent_id)
      VALUES ('caller-1', 'claude', 'completed', 'ariella'),
             ('child-1', 'claude', 'completed', 'worker')
    `;
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  function registration(text: string, extra: { reviveDeadLetter?: boolean } = {}) {
    return {
      deliveryId: "delivery-revive",
      targetSessionId: "caller-1",
      sourceSessionId: "child-1",
      relationKey: "child_session:child-1:42",
      completionId: "completion-revive",
      intent: "completion_notification" as const,
      source: "completion_notifier",
      producerKind: "child_session",
      producerId: "child-1",
      producerTerminalRevision: "42",
      payloadHash: `hash-${text}`,
      payload: { text },
      ...extra,
    };
  }

  function notificationPayload(text: string) {
    return {
      text,
      user: "agent",
      source: "completion_notifier",
      delivery_id: "delivery-revive",
      delivery_intent: "completion_notification",
      completion_id: "completion-revive",
      relation_key: "child_session:child-1:42",
      disposition: "auto_resume" as const,
      caller_info: null,
    };
  }

  async function stage(token: string, text: string) {
    return await repository.notifications.stageWithQueuedDelivery({
      deliveryId: "delivery-revive",
      attemptToken: token,
      targetSessionId: "caller-1",
      disposition: "auto_resume",
      payload: notificationPayload(text),
    });
  }

  async function outbox() {
    return await harness.sql<Array<{
      state: string;
      projection_state: string;
      attempt_token: string | null;
    }>>`
      SELECT state, projection_state, attempt_token
      FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-revive'
    `;
  }

  for (const scenario of ["discarded", "published"] as const) {
    it(`re-stages a revived delivery whose outbox row was left ${scenario}`, async () => {
      await repository.register(registration("old text"));
      await repository.claimAttemptForTarget("delivery-revive", "caller-1", "worker-1");
      await repository.beginDispatch("delivery-revive", "worker-1");
      await stage("worker-1", "old text");
      if (scenario === "published") {
        await repository.notifications.markPublished(
          "delivery-revive",
          "worker-1",
          "receipt-1",
        );
      }
      await repository.markUncertain("delivery-revive", undefined, "turn ended unconsumed");
      await expect(repository.get("delivery-revive")).resolves.toMatchObject({
        state: "uncertain",
        aggregate_state: "dead_letter",
      });
      await expect(outbox()).resolves.toEqual([
        scenario === "discarded"
          ? { state: "dead_letter", projection_state: "discarded", attempt_token: null }
          : { state: "published", projection_state: "published", attempt_token: null },
      ]);

      const revived = await repository.register(
        registration("new text", { reviveDeadLetter: true }),
      );
      expect(revived.row).toMatchObject({
        state: "pending",
        aggregate_state: "pending",
        attempt_count: 0,
      });
      await expect(outbox()).resolves.toEqual([]);

      await expect(repository.claimAttemptForTarget(
        "delivery-revive",
        "caller-1",
        "worker-2",
      )).resolves.toMatchObject({ state: "claimed" });
      await expect(repository.beginDispatch("delivery-revive", "worker-2"))
        .resolves.toMatchObject({ state: "dispatching" });
      await expect(stage("worker-2", "new text")).resolves.toMatchObject({
        state: "queued",
        aggregate_state: "pending",
      });
      await expect(outbox()).resolves.toEqual([
        { state: "claimed", projection_state: "publishing", attempt_token: "worker-2" },
      ]);
    });
  }
});
