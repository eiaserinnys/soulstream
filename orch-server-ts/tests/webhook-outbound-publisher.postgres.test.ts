import { afterEach, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";
import {
  publishSubscription,
  publishDueSubscriptions,
} from "../src/webhooks/outbound_publisher.js";
import { OutboundWebhookService } from "../src/webhooks/outbound_service.js";
import type { OutboundEventType } from "../src/webhooks/outbound_types.js";

const OWNER = "owner@example.com";
const SECRET = `whsec_${Buffer.alloc(32, 4).toString("base64")}`;
const CREATED_AT = new Date("2026-11-18T00:00:00.000Z");

let harness: FullSchemaPostgresHarness;

beforeEach(async () => {
  harness = await createFullSchemaPostgresHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

function makeService() {
  return new OutboundWebhookService({
    resolveSql: async () => harness.sql,
    authorizeUser: () => null,
    requireSessionAccess: async () => undefined,
    post: async () => ({ status: 200, body: "", retryAfter: null }),
    now: () => Date.now(),
  });
}

async function insertSession(sessionId: string, lastEventId: number | null) {
  await harness.sql`
    INSERT INTO sessions (session_id, last_event_id)
    VALUES (${sessionId}, ${lastEventId})
  `;
}

async function insertEvent(
  sessionId: string,
  id: number,
  eventType: string,
  payload: unknown,
) {
  await harness.sql`
    INSERT INTO events (session_id, id, event_type, payload, created_at)
    VALUES (${sessionId}, ${id}, ${eventType}, ${harness.sql.json(payload as never)}, ${CREATED_AT})
  `;
}

async function createSubscription(eventTypes: readonly OutboundEventType[]) {
  return await makeService().createSubscription({
    ownerEmail: OWNER,
    label: "receiver",
    targetSessionId: "s1",
    url: "https://receiver.example/hook",
    eventTypes,
    signingSecret: SECRET,
  });
}

const ALL_EVENT_TYPES: readonly OutboundEventType[] = [
  "session.reply",
  "session.question",
  "session.failed",
  "session.ended",
];

describe("outbound webhook publisher", () => {
  it("does not publish events that predate the subscription", async () => {
    await insertSession("s1", 1);
    await insertEvent("s1", 1, "complete", { type: "complete", result: "old" });

    const subscription = await createSubscription(["session.reply"]);
    const result = await publishSubscription(harness.sql, subscription.id, new Date());

    expect(result).toEqual({ inserted: 0, cursor: 1 });
    const rows = await harness.sql`SELECT id FROM webhook_deliveries`;
    expect(rows).toHaveLength(0);
  });

  it("publishes complete, input_request and both session_ended outcomes once each", async () => {
    await insertSession("s1", 0);
    const subscription = await createSubscription(ALL_EVENT_TYPES);
    await insertEvent("s1", 1, "complete", { type: "complete", result: "done" });
    await insertEvent("s1", 2, "input_request", {
      type: "input_request",
      request_id: "req-1",
      started_at: 1_700_000_000,
      timeout_sec: 600,
      questions: [
        {
          question: "Which one?",
          header: "Pick",
          options: [{ label: "a", description: "first" }],
          multiSelect: true,
        },
      ],
    });
    await insertEvent("s1", 3, "session_ended", {
      type: "session_ended",
      status: "completed",
      termination_reason: "completed_ok",
      termination_detail: "internal detail that must not leak",
    });
    await insertEvent("s1", 4, "session_ended", {
      type: "session_ended",
      status: "error",
      termination_reason: "error_aborted",
    });
    await insertEvent("s1", 5, "assistant_message", { text: "not a source" });
    await insertEvent("s1", 6, "error", { fatal: false });
    await harness.sql`UPDATE sessions SET last_event_id = 6 WHERE session_id = 's1'`;

    const result = await publishSubscription(harness.sql, subscription.id, new Date());
    expect(result).toEqual({ inserted: 4, cursor: 6 });

    const rows = await harness.sql<Array<{
      event_id: number;
      event_type: string;
      state: string;
      payload: Record<string, unknown>;
    }>>`
      SELECT event_id, event_type, state, payload
      FROM webhook_deliveries
      ORDER BY event_id
    `;
    expect(rows.map((row) => row.event_type)).toEqual([
      "session.reply",
      "session.question",
      "session.ended",
      "session.failed",
    ]);
    expect(rows.map((row) => row.state)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(rows.map((row) => row.payload.id)).toEqual(
      [1, 2, 3, 4].map((id) => `${subscription.id}:s1:${id}`),
    );
    expect(rows.map((row) => row.payload.timestamp)).toEqual(
      [1, 2, 3, 4].map(() => CREATED_AT.toISOString()),
    );
    expect(rows[0]!.payload.data).toEqual({ session_id: "s1", result: "done" });
    expect(rows[1]!.payload.data).toEqual({
      session_id: "s1",
      request_id: "req-1",
      questions: [
        {
          question: "Which one?",
          header: "Pick",
          options: [{ label: "a", description: "first" }],
          multi_select: true,
        },
      ],
      expires_at: "2023-11-14T22:23:20.000Z",
    });
    expect(rows[2]!.payload.data).toEqual({
      session_id: "s1",
      termination_reason: "completed_ok",
    });
    expect(JSON.stringify(rows[2]!.payload)).not.toContain("internal detail");
    expect(rows[3]!.payload.data).toEqual({
      session_id: "s1",
      termination_reason: "error_aborted",
    });

    const [state] = await harness.sql<Array<{ cursor_event_id: number }>>`
      SELECT cursor_event_id FROM webhook_subscriptions WHERE id = ${subscription.id}
    `;
    expect(state!.cursor_event_id).toBe(6);
  });

  it("skips notification types the subscription does not list", async () => {
    await insertSession("s1", 0);
    const subscription = await createSubscription(["session.reply", "session.failed"]);
    await insertEvent("s1", 1, "complete", { type: "complete", result: "done" });
    await insertEvent("s1", 2, "input_request", {
      type: "input_request",
      request_id: "req-1",
      questions: [],
    });
    await insertEvent("s1", 3, "session_ended", {
      type: "session_ended",
      termination_reason: "completed_ok",
    });
    await insertEvent("s1", 4, "session_ended", {
      type: "session_ended",
      termination_reason: "limit_hit",
    });
    await harness.sql`UPDATE sessions SET last_event_id = 4 WHERE session_id = 's1'`;

    const result = await publishSubscription(harness.sql, subscription.id, new Date());

    expect(result).toEqual({ inserted: 2, cursor: 4 });
    const rows = await harness.sql<Array<{ event_id: number; event_type: string }>>`
      SELECT event_id, event_type FROM webhook_deliveries ORDER BY event_id
    `;
    expect(rows).toEqual([
      { event_id: 1, event_type: "session.reply" },
      { event_id: 4, event_type: "session.failed" },
    ]);
  });

  it("does not duplicate deliveries when it runs again or twice at the same time", async () => {
    await insertSession("s1", 0);
    const subscription = await createSubscription(["session.reply"]);
    await insertEvent("s1", 1, "complete", { type: "complete", result: "done" });
    await harness.sql`UPDATE sessions SET last_event_id = 1 WHERE session_id = 's1'`;

    await publishSubscription(harness.sql, subscription.id, new Date());
    await publishSubscription(harness.sql, subscription.id, new Date());
    expect(await deliveryCount()).toBe(1);

    await insertEvent("s1", 2, "complete", { type: "complete", result: "again" });
    await harness.sql`UPDATE sessions SET last_event_id = 2 WHERE session_id = 's1'`;
    const second = await openSecondClient();
    try {
      await Promise.all([
        publishSubscription(harness.sql, subscription.id, new Date()),
        publishSubscription(second ?? harness.sql, subscription.id, new Date()),
      ]);
    } finally {
      await second?.end({ timeout: 2 });
    }
    expect(await deliveryCount()).toBe(2);
  });

  it("does not publish for an inactive subscription", async () => {
    await insertSession("s1", 0);
    const service = makeService();
    const subscription = await service.createSubscription({
      ownerEmail: OWNER,
      label: "receiver",
      targetSessionId: "s1",
      url: "https://receiver.example/hook",
      eventTypes: ["session.reply"],
      signingSecret: SECRET,
    });
    await service.setActive(OWNER, subscription.id, false);
    await insertEvent("s1", 1, "complete", { type: "complete", result: "done" });
    await harness.sql`UPDATE sessions SET last_event_id = 1 WHERE session_id = 's1'`;

    expect(await publishSubscription(harness.sql, subscription.id, new Date())).toBeNull();
    expect(await deliveryCount()).toBe(0);
    expect(await publishDueSubscriptions(harness.sql, new Date())).toEqual([]);
  });
});

async function deliveryCount(): Promise<number> {
  const [row] = await harness.sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM webhook_deliveries
  `;
  return row!.count;
}

async function openSecondClient(): Promise<ReturnType<typeof postgres> | null> {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) return null;
  const [row] = await harness.sql<Array<{ current_schema: string }>>`SELECT current_schema()`;
  return postgres(url, {
    max: 2,
    idle_timeout: 1,
    onnotice: () => {},
    connection: { search_path: row!.current_schema },
  });
}
