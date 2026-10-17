import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { backfillMessageRefsTx, messageSourceFingerprint, type MessageRefSource } from "../../scripts/attachment-migration/backfill_message_refs.js";
import { createLiveAttachmentReadRepository } from "../../src/runtime/live_attachment_read_repository.js";
import { readLiveSessionEventAttachments } from "../../src/runtime/live_session_event_attachments.js";
import { createLiveDbSqlResolver } from "../../src/runtime/live_db_sql.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "../page/page_postgres_harness.js";

describe("message ref backfill PostgreSQL contract", () => {
  let harness: PagePostgresHarness;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql`
      INSERT INTO file_assets (
        id, storage_key, storage_purpose, storage_endpoint, storage_bucket,
        original_name, mime_type, byte_size, upload_status
      ) VALUES
        ('existing-asset', 'private/existing-asset', 'attachment',
          'https://r2.example.test', 'private-attachments', 'existing.png', 'image/png', 3, 'committed'),
        ('message-ref-asset', 'private/message-ref-asset', 'attachment',
          'https://r2.example.test', 'private-attachments', 'a.png', 'image/png', 4, 'committed')
    `;
    await harness.sql`
      INSERT INTO attachment_legacy_aliases (node_id, normalized_path, asset_id, original_path, availability)
      VALUES ('node-a', '/legacy/a.png', 'message-ref-asset', '/legacy/a.png', 'resolved')
    `;
  }, 60_000);

  afterAll(async () => await harness?.cleanup());

  it.each(["user_message", "intervention_sent", "complete", "assistant_message"] as const)(
    "stores JSONB ID refs for %s and exposes them only through the matching session",
    async (eventType) => {
      const eventId = 41 + ["user_message", "intervention_sent", "complete", "assistant_message"].indexOf(eventType);
      const sessionA = `message-ref-session-a-${eventType}`;
      const sessionB = `message-ref-session-b-${eventType}`;
      await harness.sql`
        INSERT INTO sessions (session_id, node_id)
        VALUES (${sessionA}, 'node-a'), (${sessionB}, 'node-a')
      `;
      const payload = {
        text: "unchanged text",
        attachments: ["/legacy/a.png"],
        attachment_ids: ["existing-asset"],
        attachment_count: 2,
        timestamp: "2026-10-17T00:00:00.000Z",
        caller_info: { source: "browser" },
      };
      await harness.sql`
        INSERT INTO events (session_id, id, event_type, payload, searchable_text)
        VALUES
          (${sessionA}, ${eventId}, ${eventType}, ${harness.sql.json(payload)}::jsonb, 'original searchable text'),
          (${sessionB}, ${eventId}, ${eventType}, ${harness.sql.json(payload)}::jsonb, 'other session searchable text')
      `;
      const resolver = createLiveDbSqlResolver({ sql: harness.liveSql });
      const readRepository = createLiveAttachmentReadRepository(resolver);
      const before = await readLiveSessionEventAttachments(resolver, sessionA, eventId);
      expect(before?.items).toEqual([
        {
          kind: "asset",
          descriptor: {
            attachment_id: "existing-asset", name: "existing.png", mime_type: "image/png", byte_size: 3,
            checksum_sha256: null, width: null, height: null, preview_kind: "image", preview_mime_type: "image/png",
          },
          read_context: { type: "session", id: sessionA },
          legacy_sources: [],
        },
        {
          kind: "legacy", node_id: "node-a", path: "/legacy/a.png", name: "a.png", mime_type: null,
          byte_size: null, availability: "unresolved", read_context: { type: "session", id: sessionA },
        },
      ]);
      await expect(readRepository.getSqlScopeEvidence(
        { type: "session", id: sessionA }, "message-ref-asset",
      )).resolves.toMatchObject({ hasStoredRef: false });

      const row = (await harness.sql<{
        session_id: string; event_id: number; event_type: string; payload: Record<string, unknown>; created_at: Date;
      }[]>`
        SELECT session_id, id AS event_id, event_type, payload, created_at
        FROM events WHERE session_id=${sessionA} AND id=${eventId}
      `)[0]!;
      const source: MessageRefSource = row;
      const result = await backfillMessageRefsTx(
        harness.liveSql as never,
        source,
        messageSourceFingerprint(source),
        ["message-ref-asset"],
      );

      expect(result.status).toBe("updated");
      const stored = (await harness.sql<{
        session_id: string; id: number; event_type: string; searchable_text: string;
        payload: Record<string, unknown>; payload_kind: string;
      }[]>`
        SELECT session_id, id, event_type, searchable_text, payload,
          jsonb_typeof(payload->'attachment_ids') AS payload_kind
        FROM events WHERE session_id=${sessionA} AND id=${eventId}
      `)[0]!;
      expect(stored.payload_kind).toBe("array");
      expect({
        session_id: stored.session_id, id: stored.id, event_type: stored.event_type, searchable_text: stored.searchable_text,
      }).toEqual({
        session_id: sessionA, id: eventId, event_type: eventType, searchable_text: "original searchable text",
      });
      expect(stored.payload).toEqual({
        ...payload,
        attachment_ids: ["existing-asset", "message-ref-asset"],
        attachment_count: 3,
      });
      await expect(readRepository.getSqlScopeEvidence(
        { type: "session", id: sessionA }, "message-ref-asset",
      )).resolves.toMatchObject({ hasStoredRef: true });
      await expect(readRepository.getSqlScopeEvidence(
        { type: "session", id: sessionB }, "message-ref-asset",
      )).resolves.toMatchObject({ hasStoredRef: false });
      await expect(readLiveSessionEventAttachments(resolver, sessionA, eventId)).resolves.toEqual({
        event_id: eventId,
        items: [
          {
            kind: "asset",
            descriptor: {
              attachment_id: "existing-asset", name: "existing.png", mime_type: "image/png", byte_size: 3,
              checksum_sha256: null, width: null, height: null, preview_kind: "image", preview_mime_type: "image/png",
            },
            read_context: { type: "session", id: sessionA },
            legacy_sources: [],
          },
          {
            kind: "asset",
            descriptor: {
              attachment_id: "message-ref-asset", name: "a.png", mime_type: "image/png", byte_size: 4,
              checksum_sha256: null, width: null, height: null, preview_kind: "image", preview_mime_type: "image/png",
            },
            read_context: { type: "session", id: sessionA },
            legacy_sources: [{ node_id: "node-a", path: "/legacy/a.png" }],
          },
        ],
      });
      await expect(readLiveSessionEventAttachments(resolver, sessionB, eventId)).resolves.toEqual({
        event_id: eventId,
        items: [
          {
            kind: "asset",
            descriptor: {
              attachment_id: "existing-asset", name: "existing.png", mime_type: "image/png", byte_size: 3,
              checksum_sha256: null, width: null, height: null, preview_kind: "image", preview_mime_type: "image/png",
            },
            read_context: { type: "session", id: sessionB },
            legacy_sources: [],
          },
          {
            kind: "legacy", node_id: "node-a", path: "/legacy/a.png", name: "a.png", mime_type: null,
            byte_size: null, availability: "unresolved", read_context: { type: "session", id: sessionB },
          },
        ],
      });
    },
  );

  it("rejects a stale source fingerprint without updating the stored event", async () => {
    const source: MessageRefSource = {
      session_id: "message-ref-session-stale", event_id: 99, event_type: "user_message",
      payload: { attachments: ["/legacy/a.png"] }, created_at: new Date("2026-10-17T00:00:00.000Z"),
    };
    await harness.sql`INSERT INTO sessions (session_id, node_id) VALUES (${source.session_id}, 'node-a')`;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES (${source.session_id}, ${source.event_id}, ${source.event_type}, ${harness.sql.json(source.payload as never)}::jsonb, ${source.created_at})
    `;

    await expect(backfillMessageRefsTx(harness.liveSql as never, source, "stale-fingerprint", ["message-ref-asset"]))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const stored = (await harness.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events WHERE session_id=${source.session_id} AND id=${source.event_id}
    `)[0]!.payload;
    expect(stored).toEqual(source.payload);
  });
});
