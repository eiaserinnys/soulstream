import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startPostgresTestContainer } from "../../../packages/db-schema/scripts/postgres-test-container.mjs";
import { publishVerifiedAssetTx, type PublishEntry, type PublishReceipt } from "../../scripts/attachment-migration/publish_assets.js";
import type { LivePostgresSql } from "../../src/runtime/live_db_sql.js";
import { waitForPostgres } from "../persistent-session-settings-world.js";

const HASH = "a".repeat(64);
const ENDPOINT = "https://r2.example.test";
const BUCKET = "private-attachments";

describe("attachment migration asset publication PostgreSQL contract", () => {
  let sql: ReturnType<typeof postgres>;
  let stop: (() => void) | undefined;

  beforeAll(async () => {
    const container = startPostgresTestContainer({
      user: "attachment_publish_test",
      password: "attachment_publish_test",
      database: "attachment_publish_test_db",
    });
    stop = container.stop;
    const url = `postgres://attachment_publish_test:attachment_publish_test@127.0.0.1:${container.port}/attachment_publish_test_db`;
    const bootstrap = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await waitForPostgres(bootstrap);
      const schema = await readFile(new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8");
      await bootstrap.unsafe(schema);
    } finally {
      await bootstrap.end({ timeout: 2 });
    }
    sql = postgres(url, { max: 2, onnotice: () => undefined });
    expect(Number((await sql`SELECT COUNT(*) AS n FROM file_assets`)[0]!.n)).toBe(0);
  }, 90_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    stop?.();
  });

  it("publishes committed asset metadata and a resolved alias as JSON object, then repeats idempotently", async () => {
    const entry = planEntry();
    const receipt = copyReceipt(entry);

    const first = await sql.begin((tx) => publishVerifiedAssetTx(publishSql(tx), entry, receipt));
    const repeated = await sql.begin((tx) => publishVerifiedAssetTx(publishSql(tx), entry, receipt));

    expect(first).toEqual({ attachmentId: entry.proposed_asset_id, aliasCount: 1 });
    expect(repeated).toEqual(first);
    const rowsQuery = sql<{
      owner_kind: string;
      owner_key: string;
      scope_type: string;
      scope_id: string;
      upload_status: string;
      storage_purpose: string;
      storage_key: string;
      storage_endpoint: string;
      storage_bucket: string;
      source_node_id: string;
      alias_asset_id: string;
      alias_path: string;
      alias_availability: string;
    }[]>`
      SELECT a.owner_kind, a.owner_key, jsonb_typeof(a.registration_scope) AS scope_type,
             a.registration_scope->>'id' AS scope_id, a.upload_status, a.storage_purpose,
             a.storage_key, a.storage_endpoint, a.storage_bucket, a.source_node_id,
             l.asset_id AS alias_asset_id, l.original_path AS alias_path, l.availability AS alias_availability
      FROM file_assets a
      JOIN attachment_legacy_aliases l ON l.asset_id = a.id
      WHERE a.id = ${entry.proposed_asset_id!}
    `;
    const rows = await (rowsQuery as unknown as Promise<{
      owner_kind: string;
      owner_key: string;
      scope_type: string;
      scope_id: string;
      upload_status: string;
      storage_purpose: string;
      storage_key: string;
      storage_endpoint: string;
      storage_bucket: string;
      source_node_id: string;
      alias_asset_id: string;
      alias_path: string;
      alias_availability: string;
    }[]>);
    expect(rows).toEqual([{
      owner_kind: "user_email",
      owner_key: "owner@example.test",
      scope_type: "object",
      scope_id: "card-a",
      upload_status: "committed",
      storage_purpose: "attachment",
      storage_key: `session-attachments/originals/${entry.proposed_asset_id}`,
      storage_endpoint: ENDPOINT,
      storage_bucket: BUCKET,
      source_node_id: entry.legacy_node_id,
      alias_asset_id: entry.proposed_asset_id,
      alias_path: entry.normalized_path,
      alias_availability: "resolved",
    }]);
    expect(Number((await sql`SELECT COUNT(*) AS n FROM attachment_legacy_aliases WHERE node_id=${entry.legacy_node_id} AND normalized_path=${entry.normalized_path}`)[0]!.n)).toBe(1);
  });

  it("keeps unverified ownership null and preserves source provenance after source session deletion", async () => {
    await sql`INSERT INTO sessions(session_id,node_id,status) VALUES ('source-session-gone','node-a','archived')`;
    const entry = planEntry({
      identity_key: "node-a:/legacy/unowned.png",
      normalized_path: "/legacy/unowned.png",
      name: "unowned.png",
      owner: { status: "unverified", reason: "owner evidence is absent", source: "card_comments:note-a" },
      references: [{ source_kind: "comment", source_table: "card_comments", source_pk: "note-a", pointer: "/body",
        session_id: "source-session-gone", changed_after_cutoff: false,
        owner: { status: "unverified", reason: "owner evidence is absent", source: "card_comments:note-a" } }],
      proposed_asset_id: "unowned-asset-a",
      proposed_ref_action: "propose_private_attachment_asset_and_alias",
    });
    const receipt = copyReceipt(entry);

    await sql.begin((tx) => publishVerifiedAssetTx(publishSql(tx), entry, receipt));
    await sql`DELETE FROM sessions WHERE session_id='source-session-gone'`;

    const rows = await sql<{ owner_kind: string | null; owner_key: string | null; registration_scope: unknown; source_session_id: string | null }[]>`
      SELECT owner_kind, owner_key, registration_scope, source_session_id
      FROM file_assets WHERE id='unowned-asset-a'
    `;
    expect(rows).toEqual([{ owner_kind: null, owner_key: null, registration_scope: null, source_session_id: "source-session-gone" }]);
    expect(Number((await sql`SELECT COUNT(*) AS n FROM sessions WHERE session_id='source-session-gone'`)[0]!.n)).toBe(0);
  });

  it("records only a confirmed missing path as a null asset alias", async () => {
    const entry = planEntry({
      identity_key: "node-a:/legacy/gone.png",
      normalized_path: "/legacy/gone.png",
      name: "gone.png",
      status: "confirmed_missing",
      size_bytes: undefined,
      sha256: undefined,
      proposed_asset_id: undefined,
    });
    const receipt: PublishReceipt = {
      identity_key: entry.identity_key,
      attachment_id: entry.identity_key,
      storage_key: "",
      storage_endpoint: null,
      storage_bucket: null,
      byte_size: null,
      sha256: null,
      verified_at: "2026-10-17T00:00:00.000Z",
      result: "skipped_unconfirmed",
    };

    const result = await sql.begin((tx) => publishVerifiedAssetTx(publishSql(tx), entry, receipt));

    expect(result).toEqual({ attachmentId: entry.identity_key, aliasCount: 1 });
    const rows = await sql<{ asset_id: string | null; availability: string; original_path: string }[]>`
      SELECT asset_id, availability, original_path FROM attachment_legacy_aliases
      WHERE node_id=${entry.legacy_node_id} AND normalized_path=${entry.normalized_path}
    `;
    expect(rows).toEqual([{ asset_id: null, availability: "missing", original_path: entry.normalized_path }]);
    expect(Number((await sql`SELECT COUNT(*) AS n FROM file_assets WHERE id=${entry.identity_key}`)[0]!.n)).toBe(0);
  });

  it("rolls back the new asset when the legacy alias already resolves elsewhere", async () => {
    await insertExistingAsset(sql, "conflicting-alias-asset", "fixture/conflicting-alias");
    await sql`INSERT INTO attachment_legacy_aliases(node_id,normalized_path,asset_id,original_path,availability)
      VALUES ('node-a','/legacy/conflict.png','conflicting-alias-asset','/legacy/conflict.png','resolved')`;
    const entry = planEntry({
      identity_key: "node-a:/legacy/conflict.png",
      normalized_path: "/legacy/conflict.png",
      proposed_asset_id: "new-conflicting-alias-asset",
    });

    await expect(sql.begin((tx) => publishVerifiedAssetTx(publishSql(tx), entry, copyReceipt(entry))))
      .rejects.toMatchObject({ code: "ALIAS_CONFLICT" });

    expect(Number((await sql`SELECT COUNT(*) AS n FROM file_assets WHERE id='new-conflicting-alias-asset'`)[0]!.n)).toBe(0);
    const aliases = await sql<{ asset_id: string }[]>`
      SELECT asset_id FROM attachment_legacy_aliases WHERE node_id='node-a' AND normalized_path='/legacy/conflict.png'
    `;
    expect(aliases).toEqual([{ asset_id: "conflicting-alias-asset" }]);
  });

  it("rejects asset ID and storage key collisions without creating aliases", async () => {
    await insertExistingAsset(sql, "asset-id-collision", "fixture/asset-id-collision");
    const idCollision = planEntry({ proposed_asset_id: "asset-id-collision" });
    await expect(sql.begin((tx) => publishVerifiedAssetTx(publishSql(tx), idCollision, copyReceipt(idCollision))))
      .rejects.toMatchObject({ code: "ASSET_METADATA_CONFLICT" });

    await insertExistingAsset(sql, "other-storage-owner", "session-attachments/originals/new-storage-collision");
    const storageCollision = planEntry({ identity_key: "node-a:/legacy/storage-collision.png", normalized_path: "/legacy/storage-collision.png",
      proposed_asset_id: "new-storage-collision" });
    await expect(sql.begin((tx) => publishVerifiedAssetTx(publishSql(tx), storageCollision, copyReceipt(storageCollision))))
      .rejects.toMatchObject({ code: "ASSET_METADATA_CONFLICT" });
    expect(Number((await sql`SELECT COUNT(*) AS n FROM attachment_legacy_aliases WHERE normalized_path=${storageCollision.normalized_path}`)[0]!.n)).toBe(0);
  });

  it("enforces the existing alias asset foreign key and unique legacy key", async () => {
    await expect(sql`INSERT INTO attachment_legacy_aliases(node_id,normalized_path,asset_id,original_path,availability)
      VALUES ('node-a','/legacy/orphan.png','missing-asset','/legacy/orphan.png','resolved')`)
      .rejects.toMatchObject({ code: "23503" });

    await insertExistingAsset(sql, "alias-constraint-asset", "fixture/alias-constraint");
    await sql`INSERT INTO attachment_legacy_aliases(node_id,normalized_path,asset_id,original_path,availability)
      VALUES ('node-a','/legacy/unique.png','alias-constraint-asset','/legacy/unique.png','resolved')`;
    await expect(sql`INSERT INTO attachment_legacy_aliases(node_id,normalized_path,asset_id,original_path,availability)
      VALUES ('node-a','/legacy/unique.png','alias-constraint-asset','/legacy/unique.png','resolved')`)
      .rejects.toMatchObject({ code: "23505" });
  });

  it("checks existing alias assets against their already verified copy receipt", async () => {
    const existing = {
      id: "already-existing-asset",
      storage_purpose: "attachment",
      storage_key: "session-attachments/originals/already-existing-asset",
      storage_endpoint: ENDPOINT,
      storage_bucket: BUCKET,
      upload_status: "committed",
      original_name: "image.png",
      mime_type: "image/png",
      byte_size: 16,
      checksum_sha256: HASH,
      garbage_collected_at: null,
      owner_kind: null,
      owner_key: null,
      registration_scope: null,
    };
    await sql`INSERT INTO file_assets(id,storage_key,storage_purpose,storage_endpoint,storage_bucket,
      original_name,mime_type,byte_size,checksum_sha256,upload_status)
      VALUES (${existing.id},${existing.storage_key},'attachment',${ENDPOINT},${BUCKET},'image.png','image/png',16,${HASH},'committed')`;
    await sql`INSERT INTO attachment_legacy_aliases(node_id,normalized_path,asset_id,original_path,availability)
      VALUES ('node-a','/legacy/already.png',${existing.id},'/legacy/already.png','resolved')`;
    const entry = planEntry({
      normalized_path: "/legacy/already.png",
      status: "existing_alias_unverified",
      existing_alias: { node_id: "node-a", normalized_path: "/legacy/already.png", asset_id: existing.id,
        original_path: "/legacy/already.png", availability: "resolved", checked_at: "2026-10-17T00:00:00.000Z" },
      existing_asset_id: existing.id,
    });
    const receipt: PublishReceipt = {
      identity_key: entry.identity_key,
      attachment_id: existing.id,
      storage_key: existing.storage_key,
      storage_endpoint: ENDPOINT,
      storage_bucket: BUCKET,
      byte_size: existing.byte_size,
      sha256: existing.checksum_sha256,
      verified_at: "2026-10-17T00:00:00.000Z",
      result: "existing_verified",
    };

    const result = await sql.begin((tx) => publishVerifiedAssetTx(publishSql(tx), entry, receipt));
    expect(result).toEqual({ attachmentId: existing.id, aliasCount: 1 });
    await expect(sql.begin((tx) => publishVerifiedAssetTx(publishSql(tx), entry, { ...receipt, sha256: "b".repeat(64) })))
      .rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
    await expect(sql.begin((tx) => publishVerifiedAssetTx(publishSql(tx), entry, { ...receipt, storage_endpoint: "https://other-r2.example.test" })))
      .rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
    await expect(sql.begin((tx) => publishVerifiedAssetTx(publishSql(tx), entry, { ...receipt, storage_bucket: "other-private-attachments" })))
      .rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  });
});

async function insertExistingAsset(sql: ReturnType<typeof postgres>, id: string, storageKey: string): Promise<void> {
  await sql`INSERT INTO file_assets(id,storage_key,storage_purpose,original_name,mime_type,byte_size,checksum_sha256,upload_status)
    VALUES (${id},${storageKey},'attachment','fixture.bin','application/octet-stream',4,${HASH},'committed')`;
}

function planEntry(overrides: Record<string, unknown> = {}): PublishEntry {
  return {
    identity_key: "node-a:/legacy/image.png",
    legacy_node_id: "node-a",
    normalized_path: "/legacy/image.png",
    name: "image.png",
    inferred_mime: "image/png",
    owner: { status: "verified", kind: "user_email", key: "owner@example.test", scope: { type: "card", id: "card-a" }, source: "cards:card-a" },
    status: "verified_source",
    references: [{ source_kind: "card_request", source_table: "cards", source_pk: "card-a", pointer: "/request",
      session_id: null, changed_after_cutoff: false,
      owner: { status: "verified", kind: "user_email", key: "owner@example.test", scope: { type: "card", id: "card-a" }, source: "cards:card-a" } }],
    source_occurrence_count: 1,
    unreferenced_incoming: false,
    size_bytes: 16,
    sha256: HASH,
    proposed_asset_id: "legacy-asset-a",
    proposed_ref_action: "propose_attachment_asset_and_alias",
    storage_endpoint: ENDPOINT,
    storage_bucket: BUCKET,
    ...overrides,
  } as PublishEntry;
}

function copyReceipt(entry: PublishEntry): PublishReceipt {
  return {
    identity_key: entry.identity_key,
    attachment_id: entry.proposed_asset_id ?? entry.identity_key,
    storage_key: `session-attachments/originals/${entry.proposed_asset_id ?? entry.identity_key}`,
    storage_endpoint: entry.storage_endpoint,
    storage_bucket: entry.storage_bucket,
    byte_size: entry.size_bytes ?? null,
    sha256: entry.sha256 ?? null,
    verified_at: "2026-10-17T00:00:00.000Z",
    result: "copied",
  };
}

function publishSql(value: unknown): LivePostgresSql {
  return value as LivePostgresSql;
}
