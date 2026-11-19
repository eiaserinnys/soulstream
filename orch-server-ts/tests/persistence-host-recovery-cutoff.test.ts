import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { registerPersistenceHostRoutes } from "../src/control_plane/persistence_host_routes.js";
import type { PersistenceHostRepositories } from "../src/control_plane/persistence_host_runtime.js";
import { SessionDeliveryRepository } from
  "../src/control_plane/repositories/session_delivery_repository.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "../../soul-server-ts/tests/db/full_schema_postgres_harness.js";

const TOKEN = "service-token";
const NODE_ID = "node-restart";
const TARGET_SESSION_ID = "restart-target";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

/**
 * 부팅 복구 클레임은 그 노드의 지금 연결 등록 시각 이전에 접수된 행만 잡는다.
 * 7edad0de(261119): 재등록 11초 뒤 새 프로세스가 직접 접수한 배달을 같은 부팅의
 * 복구 패스가 잡아 runner_receipt_unknown으로 닫았다. 연결이 없으면 지금처럼
 * 시각 조건 없이 클레임해 이전 프로세스의 행이 영영 남지 않게 한다.
 */
describePostgres("boot recovery claim cutoff", () => {
  let harness: FullSchemaPostgresHarness;
  let repository: SessionDeliveryRepository;
  let app: ReturnType<typeof Fastify>;
  let connectedAtMs: number | undefined;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    repository = new SessionDeliveryRepository(harness.sql as unknown as SqlClient);
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_notification_outbox`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, session_type, status, agent_id)
      VALUES (${TARGET_SESSION_ID}, ${NODE_ID}, 'claude', 'completed', 'agent')
    `;
    connectedAtMs = undefined;
    app = Fastify();
    registerPersistenceHostRoutes(app, {
      nodeCredentials: null,
      authBearerToken: TOKEN,
      repositoryProvider: async () =>
        ({ deliveries: repository }) as unknown as PersistenceHostRepositories,
      nodeConnectedAtMs: () => connectedAtMs,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  async function queueDelivery(deliveryId: string, queuedAt: Date): Promise<void> {
    await repository.register({
      deliveryId,
      targetSessionId: TARGET_SESSION_ID,
      relationKey: `delivery:${deliveryId}`,
      completionId: `message:${deliveryId}`,
      intent: "durable_next_turn",
      source: "user_message",
      payloadHash: `hash:${deliveryId}`,
      payload: { text: deliveryId, user: "alice", source: "user_message" },
    });
    await harness.sql`
      UPDATE session_deliveries
      SET state = 'queued', queued_at = ${queuedAt}, updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
    `;
  }

  async function claim(attemptToken: string): Promise<string[]> {
    const response = await app.inject({
      method: "POST",
      url: "/api/session-deliveries/host/claim_queued_after_node_restart",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { args: [NODE_ID, attemptToken, 100, 15_000, false] },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as Array<{ delivery_id: string }>)
      .map((row) => row.delivery_id);
  }

  it("leaves deliveries queued after the node's current connection alone", async () => {
    const now = Date.now();
    connectedAtMs = now;
    await queueDelivery("queued-after-connect", new Date(now + 5_000));

    await expect(claim("boot-worker-after")).resolves.toEqual([]);
    await expect(repository.get("queued-after-connect")).resolves.toMatchObject({
      state: "queued",
    });
  });

  it("claims deliveries queued before the node's current connection", async () => {
    const now = Date.now();
    connectedAtMs = now;
    await queueDelivery("queued-before-connect", new Date(now - 5_000));

    await expect(claim("boot-worker-before")).resolves.toEqual([
      "queued-before-connect",
    ]);
  });

  it("claims without a cutoff when the node has no registered connection", async () => {
    await queueDelivery("queued-without-connection", new Date(Date.now() + 5_000));

    await expect(claim("boot-worker-unconnected")).resolves.toEqual([
      "queued-without-connection",
    ]);
  });
});
