import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import { createLiveAttachmentReadRepository } from "../src/runtime/live_attachment_read_repository.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

const describePostgres = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0
  ? describe
  : describe.skip;

describePostgres("live attachment read repository PostgreSQL contract", () => {
  let harness: PagePostgresHarness;
  let repository: ReturnType<typeof createLiveAttachmentReadRepository>;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql`INSERT INTO folders (id, name) VALUES ('attachment-folder', 'Attachment test')`;
    repository = createLiveAttachmentReadRepository(
      createLiveDbSqlResolver({ sql: harness.liveSql }),
    );
  }, 60_000);

  afterAll(async () => await harness?.cleanup());

  it("reads only live attachment rows and preserves resolved versus missing aliases", async () => {
    await insertAsset("asset-live", {
      ownerKind: "user_email",
      ownerKey: "owner@example.com",
      registrationScope: { type: "card", id: "card-live" },
      sourceSessionId: "session-source",
    });
    await insertAsset("asset-gc", { garbageCollected: true });
    await harness.sql`
      INSERT INTO attachment_legacy_aliases (node_id, normalized_path, asset_id, original_path, availability)
      VALUES
        ('node-live', '/legacy/a.png', 'asset-live', 'C:\\legacy\\a.png', 'resolved'),
        ('node-live', '/legacy/missing.png', NULL, 'C:\\legacy\\missing.png', 'missing')
    `;

    await expect(repository.getAsset("asset-live")).resolves.toMatchObject({
      id: "asset-live",
      storagePurpose: "attachment",
      storageEndpoint: "https://r2.example.test",
      storageBucket: "private-attachments",
      ownerKind: "user_email",
      ownerKey: "owner@example.com",
      registrationScope: { type: "card", id: "card-live" },
      sourceSessionId: "session-source",
      uploadStatus: "committed",
    });
    await expect(repository.getAsset("asset-gc")).resolves.toBeNull();
    await expect(repository.getLegacyAlias("node-live", "/legacy/a.png"))
      .resolves.toEqual({ assetId: "asset-live", availability: "resolved" });
    await expect(repository.getLegacyAlias("node-live", "/legacy/missing.png"))
      .resolves.toEqual({ assetId: null, availability: "missing" });
  });

  it("accepts only exact string-array attachment_ids on supported session event types", async () => {
    await harness.sql`
      INSERT INTO sessions (session_id, folder_id)
      VALUES ('attachment-session', 'attachment-folder')
    `;
    await insertAsset("session-user");
    await insertAsset("session-intervention");
    await insertAsset("session-complete");
    await insertAsset("session-assistant");
    await insertAsset("session-tool-result");
    await insertAsset("session-object-only");
    await insertAsset("session-scalar-id");
    const payloads = [
      ["user_message", { attachment_ids: ["session-user"] }],
      ["intervention_sent", { attachment_ids: ["session-intervention"] }],
      ["complete", { attachment_ids: ["session-complete"] }],
      ["assistant_message", { attachment_ids: ["session-assistant"] }],
      ["tool_result", { attachment_ids: ["session-tool-result"] }],
      ["assistant_message", { attachments: [{ attachment_id: "session-object-only" }] }],
      ["user_message", { attachment_ids: "session-scalar-id" }],
    ] as const;
    for (const [index, [eventType, payload]] of payloads.entries()) {
      await harness.sql`
        INSERT INTO events (session_id, id, event_type, payload)
        VALUES ('attachment-session', ${index + 1}, ${eventType}, ${harness.sql.json(payload)}::jsonb)
      `;
    }

    for (const id of ["session-user", "session-intervention", "session-complete", "session-assistant"]) {
      await expect(repository.getSqlScopeEvidence({ type: "session", id: "attachment-session" }, id))
        .resolves.toMatchObject({ hasStoredRef: true, folderId: "attachment-folder" });
    }
    for (const id of ["session-tool-result", "session-object-only", "session-scalar-id"]) {
      await expect(repository.getSqlScopeEvidence({ type: "session", id: "attachment-session" }, id))
        .resolves.toMatchObject({ hasStoredRef: false });
    }
    await expect(repository.getSqlScopeEvidence({ type: "session", id: "deleted-session" }, "session-user"))
      .resolves.toBeNull();
  });

  it("checks direct card/report/comment refs and board asset identity separately", async () => {
    await harness.sql`
      INSERT INTO cards (id, folder_id, position_key, title, attachment_refs)
      VALUES ('card-live', 'attachment-folder', 'a0', 'Card', ${harness.sql.json([{ attachment_id: "card-direct" }])}::jsonb)
    `;
    await harness.sql`
      INSERT INTO card_reports (id, card_id, title, format, body, attachment_refs)
      VALUES ('report-live', 'card-live', 'Report', 'markdown', 'body', ${harness.sql.json([{ attachment_id: "card-report" }])}::jsonb)
    `;
    await harness.sql`
      INSERT INTO card_comments (id, card_id, author_kind, body, attachment_refs)
      VALUES ('comment-live', 'card-live', 'user', 'body', ${harness.sql.json([{ attachment_id: "card-comment" }])}::jsonb)
    `;
    await harness.sql`
      INSERT INTO board_items (id, folder_id, item_type, item_id)
      VALUES ('asset-item-live', 'attachment-folder', 'asset', 'board-asset-id'),
             ('session-item-live', 'attachment-folder', 'session', 'board-asset-session')
    `;

    for (const id of ["card-direct", "card-report", "card-comment"]) {
      await expect(repository.getSqlScopeEvidence({ type: "card", id: "card-live" }, id))
        .resolves.toMatchObject({ hasStoredRef: true, folderId: "attachment-folder" });
    }
    await expect(repository.getSqlScopeEvidence({ type: "card", id: "card-live" }, "wrong-id"))
      .resolves.toMatchObject({ hasStoredRef: false });
    await expect(repository.getSqlScopeEvidence({ type: "board_item", id: "asset-item-live" }, "board-asset-id"))
      .resolves.toMatchObject({ hasStoredRef: true, folderId: "attachment-folder" });
    await expect(repository.getSqlScopeEvidence({ type: "board_item", id: "session-item-live" }, "board-asset-session"))
      .resolves.toMatchObject({ hasStoredRef: false });
    await expect(repository.listLegacyCandidateScopes({
      id: "card-direct",
      storageKey: "private/card-direct",
      storagePurpose: "attachment",
      storageEndpoint: "https://r2.example.test",
      storageBucket: "private-attachments",
      ownerKind: null,
      ownerKey: null,
      registrationScope: null,
      sourceSessionId: null,
      originalName: "card.png",
      mimeType: "image/png",
      byteSize: 3,
      width: null,
      height: null,
      checksumSha256: null,
      uploadStatus: "committed",
    })).resolves.toContainEqual({ type: "card", id: "card-live" });
  });

  it("lists existing event-ref sessions in session_id order without losing them when the source is deleted", async () => {
    await harness.sql`
      INSERT INTO sessions (session_id, folder_id)
      VALUES
        ('candidate-source-session', 'attachment-folder'),
        ('candidate-registration-session', 'attachment-folder'),
        ('candidate-target-z', 'attachment-folder'),
        ('candidate-target-a', 'attachment-folder')
    `;
    await insertAsset("legacy-event-asset", {
      registrationScope: { type: "session", id: "candidate-registration-session" },
      sourceSessionId: "candidate-source-session",
    });
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload)
      VALUES
        ('candidate-target-z', 1, 'user_message', ${harness.sql.json({ attachment_ids: ["legacy-event-asset"] })}::jsonb),
        ('candidate-target-a', 2, 'assistant_message', ${harness.sql.json({ attachment_ids: ["legacy-event-asset"] })}::jsonb),
        ('candidate-target-a', 3, 'complete', ${harness.sql.json({ attachment_ids: ["legacy-event-asset"] })}::jsonb)
    `;
    const asset = {
      id: "legacy-event-asset",
      storageKey: "private/legacy-event-asset",
      storagePurpose: "attachment",
      storageEndpoint: "https://r2.example.test",
      storageBucket: "private-attachments",
      ownerKind: null,
      ownerKey: null,
      registrationScope: { type: "session", id: "candidate-registration-session" },
      sourceSessionId: "candidate-source-session",
      originalName: "legacy-event-asset.png",
      mimeType: "image/png",
      byteSize: 8,
      width: null,
      height: null,
      checksumSha256: null,
      uploadStatus: "committed" as const,
    };

    const candidates = await repository.listLegacyCandidateScopes(asset);
    expect(candidates.filter((scope) => scope.type === "session")).toEqual([
      { type: "session", id: "candidate-target-a" },
      { type: "session", id: "candidate-target-z" },
      { type: "session", id: "candidate-registration-session" },
      { type: "session", id: "candidate-source-session" },
    ]);

    await harness.sql`DELETE FROM sessions WHERE session_id = 'candidate-source-session'`;
    await expect(repository.listLegacyCandidateScopes(asset))
      .resolves.toContainEqual({ type: "session", id: "candidate-target-a" });
  });

  async function insertAsset(
    id: string,
    options: {
      readonly ownerKind?: string;
      readonly ownerKey?: string;
      readonly registrationScope?: { readonly type: string; readonly id: string };
      readonly sourceSessionId?: string;
      readonly garbageCollected?: boolean;
    } = {},
  ): Promise<void> {
    await harness.sql`
      INSERT INTO file_assets (
        id, storage_key, storage_purpose, storage_endpoint, storage_bucket,
        owner_kind, owner_key, registration_scope, source_session_id,
        original_name, mime_type, byte_size, upload_status, garbage_collected_at
      ) VALUES (
        ${id}, ${`private/${id}`}, 'attachment', 'https://r2.example.test', 'private-attachments',
        ${options.ownerKind ?? null}, ${options.ownerKey ?? null},
        ${options.registrationScope === undefined ? null : harness.sql.json(options.registrationScope)}::jsonb,
        ${options.sourceSessionId ?? null}, ${`${id}.png`}, 'image/png', 8, 'committed',
        ${options.garbageCollected ? new Date("2026-01-01T00:00:00.000Z") : null}
      )
    `;
  }
});
