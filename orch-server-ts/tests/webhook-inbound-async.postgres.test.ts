/**
 * card #1458 — inbound admission answers before the session delivery.
 *
 * Real Postgres, the real grant repository, and the real ExternalInputService.
 * Only the session dispatch is a hand-held promise: the test decides when it
 * resolves or rejects. Every receive surface (`/api/hooks/:grant_id`,
 * `/x/:key/hook`, the access link `/x/:key/messages`) must answer while that
 * promise is still pending, because the receipt and the ledger row are the
 * durable point and the ledger recovery owns any later retry.
 */
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { parseOrchServerConfig } from "../src/config.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { ConversationHistory } from "../src/conversation/conversation_history.js";
import { ExternalAccessGrantRepository } from
  "../src/external_access/external_access_grant_repository.js";
import { ExternalAccessTokenBucket } from
  "../src/external_access/external_access_token_bucket.js";
import {
  ExternalInputService,
  type ExternalInputDispatch,
} from "../src/external_access/external_input_service.js";
import { ExternalReplySignal } from "../src/external_access/external_reply_signal.js";
import { registerExternalAccessPublicRoutes } from
  "../src/external_access/public_link_routes.js";
import { RuntimeSessionEventHub } from "../src/runtime/session_event_hub.js";
import { standardWebhookHeaders } from "../src/webhooks/standard_webhook_signature.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";

const OWNER_EMAIL = "owner@example.com";
const TARGET_SESSION = "inbound-async-target";
const PUBLIC_URL = "https://soulstream.example.test/";
/** An answer slower than this means the route waited for the dispatch. */
const ANSWER_DEADLINE_MS = 2_000;

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

interface Call {
  targetSessionId: string;
  body: Record<string, unknown>;
}

/** A dispatch whose every call waits on one promise the test settles. */
function heldDispatch() {
  const calls: Call[] = [];
  let release!: () => void;
  let fail!: (error: Error) => void;
  const held = new Promise<unknown>((resolve, reject) => {
    release = () => resolve({ status: 200, body: { ok: true } });
    fail = reject;
  });
  // The rejection is observed by the service; this keeps the bare promise
  // from counting as unhandled before the first call attaches to it.
  held.catch(() => {});
  const dispatch: ExternalInputDispatch = async (targetSessionId, body) => {
    calls.push({ targetSessionId, body });
    return await held;
  };
  return { calls, dispatch, release, fail };
}

type Injected = Awaited<ReturnType<ReturnType<typeof createApp>["inject"]>>;

/** Resolves with the response, or with "timeout" when it did not answer. */
async function answeredInTime(
  pending: Promise<Injected>,
): Promise<Injected | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ANSWER_DEADLINE_MS);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function expectAnswered(result: Injected | "timeout"): Injected {
  expect(result).not.toBe("timeout");
  return result as Injected;
}

describe("inbound admission answers before the session delivery", () => {
  let db: FullSchemaPostgresHarness;
  let sql: SqlClient;
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeAll(async () => {
    db = await createFullSchemaPostgresHarness();
    sql = db.sql as unknown as SqlClient;
  }, 120_000);

  beforeEach(async () => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
    await db.sql`DELETE FROM external_replies`;
    await db.sql`DELETE FROM session_delivery_attempts`;
    await db.sql`DELETE FROM session_delivery_relation_consumptions`;
    await db.sql`DELETE FROM session_deliveries`;
    await db.sql`DELETE FROM external_input_receipts`;
    await db.sql`DELETE FROM external_access_grants`;
    await db.sql`DELETE FROM sessions`;
    await db.sql`DELETE FROM users`;
    await db.sql`
      INSERT INTO users (email, display_name) VALUES (${OWNER_EMAIL}, '테스트 사용자')
    `;
    await db.sql`
      INSERT INTO sessions (session_id, display_name, agent_id, status)
      VALUES (${TARGET_SESSION}, '비동기 대상', 'roselin', 'running')
    `;
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  function repository(): ExternalAccessGrantRepository {
    return new ExternalAccessGrantRepository({
      sql,
      authorizeUser: async () => null,
      requireSessionAccess: async () => undefined,
    });
  }

  function service(
    dispatch: ExternalInputDispatch,
    logged: Array<Record<string, unknown>> = [],
  ): ExternalInputService {
    return new ExternalInputService({
      sql,
      grants: repository(),
      dispatch,
      logger: { warn: (fields) => { logged.push(fields); } },
    });
  }

  function hookApp(input: ExternalInputService) {
    return createApp({ config, inboundHookRoutes: { grants: repository(), service: input } });
  }

  async function issueKey() {
    return await repository().issueInboundWebhook({
      ownerEmail: OWNER_EMAIL,
      label: "빌드 알림",
      targetSessionId: TARGET_SESSION,
      authMode: "key",
    });
  }

  async function issueSignature() {
    return await repository().issueInboundWebhook({
      ownerEmail: OWNER_EMAIL,
      label: "서명 알림",
      targetSessionId: TARGET_SESSION,
      authMode: "signature",
    });
  }

  async function receipts() {
    return await db.sql<Array<{ request_id: string; delivery_id: string }>>`
      SELECT request_id, delivery_id FROM external_input_receipts
    `;
  }

  async function deliveries() {
    return await db.sql<Array<{ delivery_id: string; state: string }>>`
      SELECT delivery_id, state FROM session_deliveries
    `;
  }

  it("answers /api/hooks key mode with 202 before the dispatch settles", async () => {
    const held = heldDispatch();
    const input = service(held.dispatch);
    const app = hookApp(input);
    const grant = await issueKey();
    try {
      const response = expectAnswered(await answeredInTime(app.inject({
        method: "POST",
        url: `/api/hooks/${grant.grant.id}`,
        headers: {
          authorization: `Bearer ${grant.secret}`,
          "idempotency-key": "key-async-1",
        },
        payload: "{\"text\":\"빌드 끝\"}",
      })));
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ request_id: "key-async-1", status: "accepted" });

      // The durable point is already committed while the dispatch is held.
      const stored = await receipts();
      expect(stored).toHaveLength(1);
      expect(stored[0]!.request_id).toBe("key-async-1");
      const ledger = await deliveries();
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.delivery_id).toBe(stored[0]!.delivery_id);
      expect(ledger[0]!.state).toBe("pending");

      const status = await app.inject({
        method: "GET",
        url: `/api/hooks/${grant.grant.id}/requests/key-async-1`,
        headers: { authorization: `Bearer ${grant.secret}` },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ request_id: "key-async-1", status: "accepted" });

      held.release();
      await input.settleDispatches();
      expect(held.calls).toHaveLength(1);
      expect(held.calls[0]!.targetSessionId).toBe(TARGET_SESSION);
      expect(held.calls[0]!.body).toMatchObject({
        delivery_id: stored[0]!.delivery_id,
        delivery_intent: "human_live_steer",
        caller_info: { source: "external", transport: "webhook", grant_id: grant.grant.id },
      });
      expect(String(held.calls[0]!.body.text)).toContain("빌드 끝");
    } finally {
      held.release();
      await input.settleDispatches();
      await app.close();
    }
    expect(unhandled).toEqual([]);
  });

  it("answers /x/:key/hook with 202 before the dispatch settles", async () => {
    const held = heldDispatch();
    const input = service(held.dispatch);
    const app = hookApp(input);
    const grant = await issueKey();
    try {
      const response = expectAnswered(await answeredInTime(app.inject({
        method: "POST",
        url: `/x/${grant.secret}/hook`,
        headers: { "webhook-id": "hook-x-async" },
        payload: "{\"text\":\"키 주소\"}",
      })));
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ request_id: "hook-x-async", status: "accepted" });
      expect(await receipts()).toHaveLength(1);
      expect(await deliveries()).toHaveLength(1);
    } finally {
      held.release();
      await input.settleDispatches();
      await app.close();
    }
    expect(held.calls).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  it("answers the access link /x/:key/messages with 202 before the dispatch settles", async () => {
    const held = heldDispatch();
    const input = service(held.dispatch);
    const bucket = new ExternalAccessTokenBucket();
    const grants = repository();
    const app = Fastify();
    registerExternalAccessPublicRoutes(app, {
      sql,
      publicUrl: PUBLIC_URL,
      grants,
      inputService: input,
      history: new ConversationHistory(sql),
      stopSession: async () => "stopped",
      tokenBucket: bucket,
      eventHub: new RuntimeSessionEventHub(),
      replySignal: new ExternalReplySignal(),
    });
    const link = await grants.issue({
      kind: "link",
      ownerEmail: OWNER_EMAIL,
      label: "외부 링크",
      targetSessionId: TARGET_SESSION,
      permissions: ["send", "read_own"],
      expiresInSeconds: 3_600,
    });
    try {
      const response = expectAnswered(await answeredInTime(app.inject({
        method: "POST",
        url: `/x/${link.key}/messages`,
        payload: { text: "링크 입력", request_id: "link-async-1" },
      }) as Promise<Injected>));
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ request_id: "link-async-1", status: "accepted" });
      expect(await receipts()).toHaveLength(1);
      expect(await deliveries()).toHaveLength(1);
    } finally {
      held.release();
      await input.settleDispatches();
      await app.close();
    }
    expect(held.calls).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  it("answers a signed resend during the held dispatch with the same receipt", async () => {
    const held = heldDispatch();
    const input = service(held.dispatch);
    const app = hookApp(input);
    const grant = await issueSignature();
    const body = "{\"text\":\"같은 서명 요청\"}";
    const post = () => app.inject({
      method: "POST",
      url: `/api/hooks/${grant.grant.id}`,
      headers: standardWebhookHeaders({
        secret: grant.secret,
        webhookId: "wh_async_same",
        body,
      }),
      payload: body,
    });
    try {
      const first = expectAnswered(await answeredInTime(post()));
      const second = expectAnswered(await answeredInTime(post()));
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      expect(second.json()).toEqual(first.json());
      expect(first.json()).toEqual({ request_id: "wh_async_same", status: "accepted" });

      const stored = await receipts();
      expect(stored).toHaveLength(1);
      expect(await deliveries()).toHaveLength(1);

      held.release();
      await input.settleDispatches();
      // A resend resolves to the stored receipt, so every dispatch carries the
      // one delivery identity: the session input does not grow.
      expect(new Set(held.calls.map((call) => call.body.delivery_id)))
        .toEqual(new Set([stored[0]!.delivery_id]));
    } finally {
      held.release();
      await input.settleDispatches();
      await app.close();
    }
    expect(unhandled).toEqual([]);
  });

  it("keeps 202 and logs the failure when the held dispatch rejects", async () => {
    const held = heldDispatch();
    const logged: Array<Record<string, unknown>> = [];
    const input = service(held.dispatch, logged);
    const app = hookApp(input);
    const grant = await issueKey();
    try {
      const response = expectAnswered(await answeredInTime(app.inject({
        method: "POST",
        url: `/api/hooks/${grant.grant.id}`,
        headers: {
          authorization: `Bearer ${grant.secret}`,
          "idempotency-key": "key-async-reject",
        },
        payload: "{\"text\":\"거절\"}",
      })));
      expect(response.statusCode).toBe(202);
      expect(logged).toEqual([]);

      held.fail(new Error("node offline"));
      await input.settleDispatches();
      expect(logged).toEqual([{ grant_id: grant.grant.id, request_id: "key-async-reject" }]);
      expect(await deliveries()).toHaveLength(1);
    } finally {
      await input.settleDispatches();
      await app.close();
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });

  it("keeps 202 and logs the failure when the dispatch throws synchronously", async () => {
    const logged: Array<Record<string, unknown>> = [];
    let calls = 0;
    const throwing: ExternalInputDispatch = () => {
      calls += 1;
      throw new Error("sync failure");
    };
    const input = service(throwing, logged);
    const app = hookApp(input);
    const grant = await issueKey();
    try {
      const response = expectAnswered(await answeredInTime(app.inject({
        method: "POST",
        url: `/api/hooks/${grant.grant.id}`,
        headers: {
          authorization: `Bearer ${grant.secret}`,
          "idempotency-key": "key-async-throw",
        },
        payload: "{\"text\":\"동기 예외\"}",
      })));
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ request_id: "key-async-throw", status: "accepted" });
      await input.settleDispatches();
      expect(calls).toBe(1);
      expect(logged).toEqual([{ grant_id: grant.grant.id, request_id: "key-async-throw" }]);
      expect(await deliveries()).toHaveLength(1);
    } finally {
      await app.close();
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });
});
