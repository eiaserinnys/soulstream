/**
 * card #1457 — external input admission keeps one receipt and one delivery
 * ledger row per (grant, request_id). The receipt stores the exact intervention
 * body, so the re-registration through executeSessionIntervention after the
 * admission commit must not conflict and must not dead-letter the row.
 */
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { registerSessionDelivery } from
  "../src/control_plane/repositories/session_delivery_relation_repository.js";
import {
  createExternalInterventionDispatch,
  ExternalInputService,
  type ExternalInputServiceOptions,
} from "../src/external_access/external_input_service.js";
import {
  hashExternalAccessKey,
  type ExternalAccessGrant,
} from "../src/external_access/external_access_grant_repository.js";
import type { SessionActionCommandRouteOptions } from "../src/index.js";
import { createPagePostgresHarness, type PagePostgresHarness } from
  "./page/page_postgres_harness.js";
import { createHarnessCore } from "./session-action-command-test-helpers.js";

const OWNER_EMAIL = "owner@example.com";
const GRANT_ID = "8ac1d4f2-57b3-4f4e-9d0b-2c3a4b5c6d7e";
const TARGET_SESSION = "external-target-session";

function extractSchemaBlock(schemaSql: string, pattern: RegExp): string {
  const match = schemaSql.match(pattern);
  if (match === null) throw new Error(`schema block not found: ${pattern}`);
  return match[0];
}

function grant(): ExternalAccessGrant {
  return {
    id: GRANT_ID,
    kind: "link",
    owner_email: OWNER_EMAIL,
    label: "테스트 링크",
    target_session_id: TARGET_SESSION,
    permissions: ["send", "read_own"],
    auth_mode: "key",
    key_hash: hashExternalAccessKey("ssxl_unused_secret"),
    signing_secret: null,
    preamble: null,
    expires_at: new Date("2026-12-01T00:00:00.000Z"),
    revoked_at: null,
    created_at: new Date("2026-11-01T00:00:00.000Z"),
    last_used_at: null,
  };
}

describe("ExternalInputService.admit", () => {
  let harness: PagePostgresHarness;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    const schemaSql = await readFile(
      new URL("../../packages/db-schema/sql/schema.sql", import.meta.url),
      "utf8",
    );
    await harness.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        display_name TEXT,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        allowed_folder_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by TEXT
      );
    `);
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS external_access_grants \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS external_input_receipts \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS external_replies \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS session_deliveries \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /ALTER TABLE session_deliveries\n    ADD COLUMN IF NOT EXISTS aggregate_state[\s\S]*?;/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /ALTER TABLE session_deliveries\n    ADD CONSTRAINT session_deliveries_aggregate_state_check[\s\S]*?;/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS session_delivery_attempts \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS session_delivery_relation_consumptions \([\s\S]*?\n\);/,
    ));
  }, 60_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_attempts`;
    await harness.sql`DELETE FROM session_delivery_relation_consumptions`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM external_replies`;
    await harness.sql`DELETE FROM external_input_receipts`;
    await harness.sql`DELETE FROM external_access_grants`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`DELETE FROM users`;
    await harness.sql`
      INSERT INTO users (email, display_name) VALUES (${OWNER_EMAIL}, '테스트 사용자')
    `;
    await harness.sql`
      INSERT INTO sessions (session_id, status) VALUES (${TARGET_SESSION}, 'running')
    `;
    const fixture = grant();
    await harness.sql`
      INSERT INTO external_access_grants (
        id, kind, owner_email, label, target_session_id, permissions,
        auth_mode, key_hash, expires_at, created_at
      ) VALUES (
        ${fixture.id}, ${fixture.kind}, ${fixture.owner_email}, ${fixture.label},
        ${fixture.target_session_id}, ${fixture.permissions}::TEXT[],
        ${fixture.auth_mode}, ${fixture.key_hash}, ${fixture.expires_at},
        ${fixture.created_at}
      )
    `;
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  function createService(
    overrides: Partial<ExternalInputServiceOptions> = {},
  ): ExternalInputService {
    return new ExternalInputService({
      sql: harness.sql as unknown as SqlClient,
      grants: { touchLastUsedAt: async () => {} },
      dispatch: async () => {},
      ...overrides,
    });
  }

  it("admits one receipt and one ledger row for the external sender", async () => {
    const dispatched: Array<{
      targetSessionId: string;
      body: Record<string, unknown>;
    }> = [];
    const service = createService({
      dispatch: async (targetSessionId, body) => {
        dispatched.push({ targetSessionId, body });
      },
    });

    const result = await service.admit(grant(), { text: "안녕하세요" });

    expect(result).toMatchObject({ ok: true, status: "accepted" });
    const receipts = await harness.sql<
      Array<{ grant_id: string; request_id: string; delivery_id: string }>
    >`SELECT grant_id, request_id, delivery_id FROM external_input_receipts`;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ grant_id: GRANT_ID });
    const deliveries = await harness.sql<
      Array<{
        delivery_id: string;
        intent: string;
        source: string;
        state: string;
        aggregate_state: string;
        payload: Record<string, unknown>;
      }>
    >`SELECT delivery_id, intent, source, state, aggregate_state, payload
      FROM session_deliveries`;
    expect(deliveries).toHaveLength(1);
    expect(receipts[0]!.delivery_id).toBe(deliveries[0]!.delivery_id);
    expect(deliveries[0]).toMatchObject({
      intent: "human_live_steer",
      source: "external",
      state: "pending",
      aggregate_state: "pending",
      payload: {
        text: "안녕하세요",
        user: "",
        caller_info: {
          source: "external",
          transport: "access_link",
          grant_id: GRANT_ID,
          display_name: "테스트 링크",
          user_id: null,
          issued_by: OWNER_EMAIL,
        },
      },
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.targetSessionId).toBe(TARGET_SESSION);
    const body = dispatched[0]!.body as {
      caller_info: Record<string, unknown>;
      context_items: Array<{ key: string; content: Record<string, unknown> }>;
    };
    expect(body.caller_info).toEqual({
      source: "external",
      transport: "access_link",
      grant_id: GRANT_ID,
      display_name: "테스트 링크",
      user_id: null,
      issued_by: OWNER_EMAIL,
    });
    expect(body.context_items).toHaveLength(1);
    expect(body.context_items[0]!.key).toBe("external_sender");
    expect(body.context_items[0]!.content).toMatchObject({
      transport: "access_link",
      request_handle: `${GRANT_ID}:${result.ok ? result.request_id : ""}`,
    });
  });

  it("keeps one delivery row for the same request id and text", async () => {
    const service = createService();

    const first = await service.admit(grant(), {
      text: "같은 글",
      request_id: "req-same",
    });
    const second = await service.admit(grant(), {
      text: "같은 글",
      request_id: "req-same",
    });

    expect(second).toEqual(first);
    const receipts = await harness.sql<Array<{ delivery_id: string }>>`
      SELECT delivery_id FROM external_input_receipts
    `;
    const deliveries = await harness.sql<
      Array<{ delivery_id: string; state: string; aggregate_state: string }>
    >`SELECT delivery_id, state, aggregate_state FROM session_deliveries`;
    expect(receipts).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    expect(receipts[0]!.delivery_id).toBe(deliveries[0]!.delivery_id);
    expect(deliveries[0]!.aggregate_state).not.toBe("dead_letter");
    expect(deliveries[0]!.state).toBe("pending");
  });

  it("re-registers the committed body through executeSessionIntervention without a conflict", async () => {
    const { router, bridge } = createHarnessCore();
    vi.spyOn(router, "routeExistingSessionPendingCommand").mockImplementation(
      async (payload: unknown) => payload as never,
    );
    const sendPendingCommand = vi.spyOn(bridge, "sendPendingCommand")
      .mockResolvedValue({ type: "intervene_ack", status: "ok" } as never);
    const commands = {
      router,
      bridge,
      deliveryRepositoryProvider: async () => ({
        register: async (params: Parameters<typeof registerSessionDelivery>[1]) =>
          await registerSessionDelivery(harness.sql as unknown as SqlClient, params),
      }),
    } as unknown as SessionActionCommandRouteOptions;
    const service = createService({
      dispatch: createExternalInterventionDispatch(commands),
    });

    const result = await service.admit(grant(), {
      text: "재등록 확인",
      request_id: "req-redispatch",
    });

    expect(result).toMatchObject({ ok: true, status: "accepted" });
    const deliveries = await harness.sql<
      Array<{ delivery_id: string; state: string; aggregate_state: string }>
    >`SELECT delivery_id, state, aggregate_state FROM session_deliveries`;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      state: "pending",
      aggregate_state: "pending",
    });
    // 커밋 뒤 재등록이 끝까지 갔다는 증거: 노드로 나간 명령이 그 전달 하나다.
    expect(sendPendingCommand).toHaveBeenCalledTimes(1);
    const routed = sendPendingCommand.mock.calls[0]![0] as { delivery_id?: string };
    expect(routed.delivery_id).toBe(deliveries[0]!.delivery_id);
    const attempts = await harness.sql`SELECT 1 FROM session_delivery_attempts`;
    expect(attempts).toHaveLength(0);
  });

  it("answers a different text for the same request id with a conflict", async () => {
    const service = createService();
    await service.admit(grant(), { text: "원문", request_id: "req-diff" });

    const result = await service.admit(grant(), {
      text: "다른 글",
      request_id: "req-diff",
    });

    expect(result).toEqual({ ok: false, reason: "conflict" });
    const receipts = await harness.sql`SELECT 1 FROM external_input_receipts`;
    const deliveries = await harness.sql<
      Array<{ payload: { text: string } }>
    >`SELECT payload FROM session_deliveries`;
    expect(receipts).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.payload.text).toBe("원문");
  });

  it("keeps one receipt and one delivery row when two admissions race", async () => {
    const first = createService({
      sql: harness.sql as unknown as SqlClient,
    });
    const second = createService({
      sql: harness.concurrentSql as unknown as SqlClient,
    });

    const [left, right] = await Promise.all([
      first.admit(grant(), { text: "동시", request_id: "req-race" }),
      second.admit(grant(), { text: "동시", request_id: "req-race" }),
    ]);

    expect(left).toMatchObject({ ok: true, status: "accepted" });
    expect(right).toMatchObject({ ok: true, status: "accepted" });
    const receipts = await harness.sql<Array<{ delivery_id: string }>>`
      SELECT delivery_id FROM external_input_receipts
    `;
    const deliveries = await harness.sql<Array<{ delivery_id: string }>>`
      SELECT delivery_id FROM session_deliveries
    `;
    expect(receipts).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    expect(receipts[0]!.delivery_id).toBe(deliveries[0]!.delivery_id);
  });

  it("answers accepted when the send fails after the admission commit", async () => {
    const service = createService({
      dispatch: async () => {
        throw new Error("node offline");
      },
    });

    const result = await service.admit(grant(), {
      text: "전송 실패",
      request_id: "req-send-fail",
    });

    expect(result).toMatchObject({ ok: true, status: "accepted" });
    const deliveries = await harness.sql`SELECT 1 FROM session_deliveries`;
    expect(deliveries).toHaveLength(1);
  });
});
