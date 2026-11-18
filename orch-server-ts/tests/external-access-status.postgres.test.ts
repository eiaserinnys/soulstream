/**
 * card #1457 — request status is read from the receipt, the delivery ledger,
 * the final reply, and the observed session state. Completion is decided only
 * by the explicit final reply; a stopped session is an observation, not the
 * request outcome.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { ExternalInputService } from "../src/external_access/external_input_service.js";
import {
  hashExternalAccessKey,
  type ExternalAccessGrant,
} from "../src/external_access/external_access_grant_repository.js";
import { createPagePostgresHarness, type PagePostgresHarness } from
  "./page/page_postgres_harness.js";

const OWNER_EMAIL = "owner@example.com";
const GRANT_ID = "1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b";
const TARGET_SESSION = "external-status-target";

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
    label: "상태 링크",
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

describe("ExternalInputService.readStatus", () => {
  let harness: PagePostgresHarness;
  let service: ExternalInputService;

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
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_external_replies_final[\s\S]*?;/,
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
    await harness.sql.unsafe(
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_event_id INTEGER`,
    );
  }, 60_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM external_replies`;
    await harness.sql`DELETE FROM session_deliveries`;
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
    service = new ExternalInputService({
      sql: harness.sql as unknown as SqlClient,
      grants: { touchLastUsedAt: async () => {} },
      dispatch: async () => {},
    });
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  async function insertRequest(input: {
    requestId: string;
    deliveryState?: string;
    aggregateState?: string;
  }): Promise<string> {
    const deliveryId = randomUUID();
    await harness.sql`
      INSERT INTO external_input_receipts (
        grant_id, request_id, request_hash, delivery_id,
        target_session_id, payload, caller_info
      ) VALUES (
        ${GRANT_ID}, ${input.requestId}, ${"a".repeat(64)}, ${deliveryId},
        ${TARGET_SESSION}, ${harness.sql.json({})}, ${harness.sql.json({})}
      )
    `;
    if (input.deliveryState !== undefined) {
      await harness.sql`
        INSERT INTO session_deliveries (
          delivery_id, target_session_id, relation_key, intent, source,
          payload_hash, payload, state, aggregate_state
        ) VALUES (
          ${deliveryId}, ${TARGET_SESSION},
          ${`user_message:${TARGET_SESSION}:${deliveryId}`},
          'human_live_steer', 'external', ${"b".repeat(64)},
          ${harness.sql.json({})}, ${input.deliveryState},
          ${input.aggregateState ?? input.deliveryState}
        )
      `;
    }
    return deliveryId;
  }

  it("reports accepted and processing from the delivery ledger", async () => {
    await insertRequest({ requestId: "req-accepted" });
    const accepted = await service.readExternalRequestStatus(grant(), "req-accepted");
    expect(accepted).toEqual({
      ok: true,
      status: {
        request_id: "req-accepted",
        status: "accepted",
        replies: [],
        session: { state: "running" },
      },
    });

    const deliveryId = await insertRequest({
      requestId: "req-processing",
      deliveryState: "consumed",
      aggregateState: "consumed",
    });
    expect(deliveryId).toBeTruthy();
    const processing = await service.readExternalRequestStatus(grant(), "req-processing");
    expect(processing).toMatchObject({
      ok: true,
      status: { status: "processing", replies: [] },
    });
  });

  it("completes only on the final reply and reports its outcome", async () => {
    await insertRequest({ requestId: "req-replied" });
    await harness.sql`
      INSERT INTO external_replies (grant_id, request_id, session_id, text, final, created_at)
      VALUES (
        ${GRANT_ID}, 'req-replied', ${TARGET_SESSION}, '첫 회신', FALSE,
        NOW() - INTERVAL '2 seconds'
      )
    `;
    await harness.sql`
      INSERT INTO external_replies (grant_id, request_id, session_id, text, final, created_at)
      VALUES (
        ${GRANT_ID}, 'req-replied', ${TARGET_SESSION}, '마지막 회신', TRUE,
        NOW() - INTERVAL '1 second'
      )
    `;
    const replied = await service.readExternalRequestStatus(grant(), "req-replied");
    expect(replied).toMatchObject({
      ok: true,
      status: { status: "completed", outcome: "replied" },
    });
    if (!replied.ok) throw new Error("unreachable");
    expect(replied.status.replies).toHaveLength(2);
    expect(replied.status.replies.map((reply) => reply.text))
      .toEqual(["첫 회신", "마지막 회신"]);
    expect(typeof replied.status.replies[0]!.at).toBe("string");

    await insertRequest({ requestId: "req-no-reply" });
    await harness.sql`
      INSERT INTO external_replies (grant_id, request_id, session_id, text, final)
      VALUES (${GRANT_ID}, 'req-no-reply', ${TARGET_SESSION}, '', TRUE)
    `;
    const noReply = await service.readExternalRequestStatus(grant(), "req-no-reply");
    expect(noReply).toMatchObject({
      ok: true,
      status: { status: "completed", outcome: "no_reply" },
    });
  });

  it("reports failed and the observed session state", async () => {
    await insertRequest({
      requestId: "req-failed",
      deliveryState: "uncertain",
      aggregateState: "dead_letter",
    });
    const failed = await service.readExternalRequestStatus(grant(), "req-failed");
    expect(failed).toMatchObject({
      ok: true,
      status: {
        status: "failed",
        error: { code: "delivery_failed" },
        session: { state: "running" },
      },
    });

    await insertRequest({ requestId: "req-states" });
    const states: Array<[string, number | null, string]> = [
      ["completed", 1, "idle"],
      ["error", 2, "error"],
      ["interrupted", 3, "stopped"],
      ["completed", null, "running"],
    ];
    for (const [sessionStatus, terminationEventId, expected] of states) {
      await harness.sql`
        UPDATE sessions
        SET status = ${sessionStatus}, termination_event_id = ${terminationEventId}
        WHERE session_id = ${TARGET_SESSION}
      `;
      const result = await service.readExternalRequestStatus(grant(), "req-states");
      expect(result).toMatchObject({
        ok: true,
        status: { session: { state: expected } },
      });
    }
  });
});
