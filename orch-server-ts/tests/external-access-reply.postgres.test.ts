/**
 * card #1457 — the target agent replies to an external request through the
 * internal MCP tool. Intermediate replies are multiple, the final reply closes
 * the request, and a closed request rejects later posts. The caller session is
 * the authenticated context, never an argument.
 */
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { ExternalInputService } from "../src/external_access/external_input_service.js";
import {
  hashExternalAccessKey,
  type ExternalAccessGrant,
} from "../src/external_access/external_access_grant_repository.js";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpCallContext, McpHostOptions } from "../src/mcp/types.js";
import { createPagePostgresHarness, type PagePostgresHarness } from
  "./page/page_postgres_harness.js";

const OWNER_EMAIL = "owner@example.com";
const GRANT_ID = "5d0c7a1e-2b34-4c56-8d78-9a0b1c2d3e4f";
const TARGET_SESSION = "external-reply-target";
const OTHER_SESSION = "another-agent-session";

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
    label: "회신 링크",
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

describe("reply_to_external_request", () => {
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
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS session_delivery_attempts \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS session_delivery_relation_consumptions \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_event_id INTEGER`,
    );
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

  function inputService(): ExternalInputService {
    return new ExternalInputService({
      sql: harness.sql as unknown as SqlClient,
      grants: { touchLastUsedAt: async () => {} },
      dispatch: async () => {},
    });
  }

  async function admit(requestId: string): Promise<string> {
    const result = await inputService().admit(grant(), {
      text: `요청 ${requestId}`,
      request_id: requestId,
    });
    if (!result.ok) throw new Error(`admit failed: ${result.reason}`);
    return `${GRANT_ID}:${result.request_id}`;
  }

  function options(sql: SqlClient): McpHostOptions {
    return {
      externalAccess: { sql },
      cluster: { logger: { warn: () => {} } },
    } as unknown as McpHostOptions;
  }

  function context(callerSessionId: string | null): McpCallContext {
    return { principal: "internal", callerSessionId, nodeId: "test-node" };
  }

  async function replyWith(
    sql: SqlClient,
    args: Record<string, unknown>,
    callerSessionId: string | null = TARGET_SESSION,
  ): Promise<Record<string, unknown>> {
    const result = await executeMcpTool(
      options(sql),
      "reply_to_external_request",
      args,
      context(callerSessionId),
    );
    return (result as { structuredContent?: unknown })
      .structuredContent as Record<string, unknown>;
  }

  async function readStatus(requestId: string) {
    const result = await inputService().readExternalRequestStatus(grant(), requestId);
    if (!result.ok) throw new Error(`status failed: ${result.reason}`);
    return result.status;
  }

  async function replyRows(requestId: string): Promise<
    Array<{ text: string; final: boolean; session_id: string }>
  > {
    return await harness.sql<Array<{ text: string; final: boolean; session_id: string }>>`
      SELECT text, final, session_id FROM external_replies
      WHERE grant_id = ${GRANT_ID} AND request_id = ${requestId}
      ORDER BY created_at, id
    `;
  }

  it("records intermediate replies and completes on the final one", async () => {
    const handle = await admit("req-two");

    const first = await replyWith(
      harness.sql as unknown as SqlClient,
      { request_handle: handle, text: "첫 회신", final: false },
    );
    expect(first).toMatchObject({ request_handle: handle, final: false });
    expect(typeof first.reply_id).toBe("string");
    expect(typeof first.at).toBe("string");

    const second = await replyWith(
      harness.sql as unknown as SqlClient,
      { request_handle: handle, text: "마지막 회신", final: true },
    );
    expect(second).toMatchObject({ request_handle: handle, final: true });

    const status = await readStatus("req-two");
    expect(status).toMatchObject({ status: "completed", outcome: "replied" });
    expect(status.replies.map((entry) => entry.text)).toEqual(["첫 회신", "마지막 회신"]);
  });

  it("closes without text and reads as no_reply", async () => {
    const handle = await admit("req-no-reply");

    const closed = await replyWith(
      harness.sql as unknown as SqlClient,
      { request_handle: handle, final: true },
    );

    expect(closed).toMatchObject({ request_handle: handle, final: true });
    const status = await readStatus("req-no-reply");
    expect(status).toMatchObject({ status: "completed", outcome: "no_reply" });
    expect(status.replies).toHaveLength(1);
    expect(status.replies[0]!.text).toBe("");
  });

  it("rejects a post after the request is closed", async () => {
    const handle = await admit("req-closed");
    await replyWith(harness.sql as unknown as SqlClient, {
      request_handle: handle,
      text: "마감",
      final: true,
    });

    const rejected = await replyWith(harness.sql as unknown as SqlClient, {
      request_handle: handle,
      text: "마감 뒤",
      final: false,
    });

    expect(rejected).toMatchObject({ error: "external_request_closed" });
    expect(await replyRows("req-closed")).toHaveLength(1);
  });

  it("lets only one of two concurrent final replies through", async () => {
    const handle = await admit("req-race");

    const [left, right] = await Promise.all([
      replyWith(harness.sql as unknown as SqlClient, {
        request_handle: handle,
        text: "동시 하나",
        final: true,
      }),
      replyWith(harness.concurrentSql as unknown as SqlClient, {
        request_handle: handle,
        text: "동시 둘",
        final: true,
      }),
    ]);

    const outcomes = [left, right].map((value) =>
      value.error === undefined ? "ok" : String(value.error)
    ).sort();
    expect(outcomes).toEqual(["external_request_closed", "ok"]);
    const rows = await replyRows("req-race");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.final).toBe(true);
  });

  it("hides requests of another session behind not_found", async () => {
    const handle = await admit("req-foreign");

    const result = await replyWith(
      harness.sql as unknown as SqlClient,
      { request_handle: handle, text: "남의 요청", final: true },
      OTHER_SESSION,
    );

    expect(result).toMatchObject({ error: "external_request_not_found" });
    expect(await replyRows("req-foreign")).toHaveLength(0);
  });

  it("answers a missing request and a malformed handle with error codes", async () => {
    await admit("req-exists");

    const missing = await replyWith(harness.sql as unknown as SqlClient, {
      request_handle: `${GRANT_ID}:req-missing`,
      text: "없는 요청",
      final: true,
    });
    expect(missing).toMatchObject({ error: "external_request_not_found" });

    for (const handle of [
      "not-a-handle",
      `not-a-uuid:req-exists`,
      `${GRANT_ID}:`,
    ]) {
      const malformed = await replyWith(harness.sql as unknown as SqlClient, {
        request_handle: handle,
        text: "형식 오류",
        final: true,
      });
      expect(malformed).toMatchObject({ error: "invalid_request_handle" });
    }
  });

  it("requires text for a non-final reply", async () => {
    const handle = await admit("req-empty");

    const empty = await replyWith(harness.sql as unknown as SqlClient, {
      request_handle: handle,
      text: "   ",
      final: false,
    });
    expect(empty).toMatchObject({ error: "reply_text_required" });

    const omitted = await replyWith(harness.sql as unknown as SqlClient, {
      request_handle: handle,
      final: false,
    });
    expect(omitted).toMatchObject({ error: "reply_text_required" });
    expect(await replyRows("req-empty")).toHaveLength(0);
  });

  it("rejects external principals", async () => {
    const handle = await admit("req-principal");
    const result = await executeMcpTool(
      options(harness.sql as unknown as SqlClient),
      "reply_to_external_request",
      { request_handle: handle, text: "외부 주체", final: true },
      { ...context(TARGET_SESSION), principal: "external" },
    );
    expect((result as { structuredContent?: unknown }).structuredContent)
      .toMatchObject({ error: "internal_principal_required" });
    expect(await replyRows("req-principal")).toHaveLength(0);
  });

  it("records a reply for a request of a revoked grant", async () => {
    const handle = await admit("req-revoked");
    await harness.sql`
      UPDATE external_access_grants SET revoked_at = NOW() WHERE id = ${GRANT_ID}
    `;

    const result = await replyWith(harness.sql as unknown as SqlClient, {
      request_handle: handle,
      text: "폐기 뒤 회신",
      final: true,
    });

    expect(result).toMatchObject({ request_handle: handle, final: true });
    const rows = await replyRows("req-revoked");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: "폐기 뒤 회신", final: true, session_id: TARGET_SESSION });
  });
});
