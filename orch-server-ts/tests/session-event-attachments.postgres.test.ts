import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import { readLiveSessionEventAttachments } from "../src/runtime/live_session_event_attachments.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

const describePostgres = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0
  ? describe
  : describe.skip;

describePostgres("session event attachment PostgreSQL projection", () => {
  let harness: PagePostgresHarness;
  let readEvent: typeof readLiveSessionEventAttachments;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql`
      INSERT INTO sessions (session_id, node_id)
      VALUES ('attachment-session-a', 'node-a'), ('attachment-session-b', 'node-b')
    `;
    readEvent = (sqlResolver, sessionId, eventId) =>
      readLiveSessionEventAttachments(sqlResolver, sessionId, eventId);
  }, 60_000);

  afterAll(async () => await harness?.cleanup());

  it("reads the exact session/event key and resolves same-basename aliases by node", async () => {
    const sqlResolver = createLiveDbSqlResolver({ sql: harness.liveSql });
    await insertAsset("asset-a");
    await insertAsset("asset-b");
    await harness.sql`
      INSERT INTO attachment_legacy_aliases (node_id, normalized_path, asset_id, original_path, availability)
      VALUES
        ('node-a', '/legacy/same.txt', 'asset-a', '/legacy/same.txt', 'resolved'),
        ('node-b', '/legacy/same.txt', 'asset-b', '/legacy/same.txt', 'resolved')
    `;

    const pathPayload = { attachments: ["/legacy/same.txt"] };
    const sessionARef = { attachment_ids: ["asset-a"] };
    const sessionBRef = { attachment_ids: ["asset-b"] };
    for (const [sessionId, refPayload] of [
      ["attachment-session-a", sessionARef],
      ["attachment-session-b", sessionBRef],
    ] as const) {
      await harness.sql`
        INSERT INTO events (session_id, id, event_type, payload)
        VALUES
          (${sessionId}, 41, 'user_message', ${harness.sql.json(pathPayload)}::jsonb),
          (${sessionId}, 42, 'assistant_message', ${harness.sql.json(refPayload)}::jsonb)
      `;
    }

    const payloadRows = await harness.sql<{ session_id: string; id: number; payload_kind: string }[]>`
      SELECT session_id, id, jsonb_typeof(payload) AS payload_kind
      FROM events WHERE id IN (41, 42) ORDER BY session_id, id
    `;
    expect(payloadRows).toHaveLength(4);
    expect(payloadRows.every((row) => row.payload_kind === "object")).toBe(true);

    const sessionA = await readEvent(sqlResolver, "attachment-session-a", 41);
    const sessionB = await readEvent(sqlResolver, "attachment-session-b", 41);
    expect(sessionA?.items).toEqual([
      expect.objectContaining({
        kind: "asset",
        descriptor: expect.objectContaining({ attachment_id: "asset-a" }),
        read_context: { type: "session", id: "attachment-session-a" },
        legacy_sources: [{ node_id: "node-a", path: "/legacy/same.txt" }],
      }),
    ]);
    expect(sessionB?.items).toEqual([
      expect.objectContaining({
        kind: "asset",
        descriptor: expect.objectContaining({ attachment_id: "asset-b" }),
        read_context: { type: "session", id: "attachment-session-b" },
        legacy_sources: [{ node_id: "node-b", path: "/legacy/same.txt" }],
      }),
    ]);
    expect(await readEvent(sqlResolver, "attachment-session-a", 99)).toBeNull();

    const explain = await harness.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL enable_seqscan = off");
      return tx<{ "QUERY PLAN": unknown }[]>`
        EXPLAIN (FORMAT JSON)
        SELECT s.node_id AS session_node_id, e.event_type, e.payload
        FROM sessions s
        JOIN events e ON e.session_id = s.session_id
        WHERE s.session_id = 'attachment-session-a' AND e.id = 41
        LIMIT 1
      `;
    });
    const planText = JSON.stringify(explain[0]?.["QUERY PLAN"]);
    expect(planText).toContain("events_pkey");
    expect(planText).toMatch(/Index Cond.*session_id.*id/);

    async function insertAsset(id: string): Promise<void> {
      await harness.sql`
        INSERT INTO file_assets (
          id, storage_key, storage_purpose, storage_endpoint, storage_bucket,
          original_name, mime_type, byte_size, upload_status
        ) VALUES (
          ${id}, ${`private/${id}`}, 'attachment', 'https://r2.example.test', 'private-attachments',
          'same.txt', 'text/plain', 4, 'committed'
        )
      `;
    }
  });
});
