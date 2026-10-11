import type { AttachmentScope } from "@soulstream/wire-schema/attachments";

import type { LiveDbSqlResolver, LivePostgresSql } from "./live_db_sql.js";
import {
  attachmentScopeFromRegistrationScope,
  type AttachmentAssetRow,
  type AttachmentLegacyAliasRow,
  type AttachmentReadRepository,
  type AttachmentScopeEvidence,
} from "../attachments/attachment_read_service.js";

export function createLiveAttachmentReadRepository(
  sqlResolver: LiveDbSqlResolver,
): AttachmentReadRepository {
  return {
    async getAsset(id) {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT id, storage_key, storage_purpose, storage_endpoint, storage_bucket,
               owner_kind, owner_key, registration_scope, source_session_id,
               original_name, mime_type, byte_size, width, height,
               checksum_sha256, upload_status
        FROM file_assets
        WHERE id = ${id} AND garbage_collected_at IS NULL
        LIMIT 1
      `;
      return rows.length === 0 ? null : assetFromRow(rows[0]!);
    },
    async getLegacyAlias(nodeId, normalizedPath) {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT asset_id, availability
        FROM attachment_legacy_aliases
        WHERE node_id = ${nodeId} AND normalized_path = ${normalizedPath}
        LIMIT 1
      `;
      if (rows.length === 0) return null;
      const row = rows[0]!;
      if (row.availability !== "resolved" && row.availability !== "missing") {
        throw new Error("Invalid attachment alias availability");
      }
      return {
        assetId: nullableString(row.asset_id),
        availability: row.availability,
      } satisfies AttachmentLegacyAliasRow;
    },
    async getSqlScopeEvidence(scope, attachmentId) {
      const sql = await sqlResolver.resolveSql();
      if (scope.type === "session") {
        const rows = await sql`
          SELECT s.session_id AS id, s.folder_id,
            COALESCE(EXISTS (
              SELECT 1 FROM events e
              WHERE e.session_id = s.session_id
                AND e.event_type IN ('user_message', 'intervention_sent', 'complete', 'assistant_message')
                AND jsonb_typeof(e.payload->'attachment_ids') = 'array'
                AND COALESCE(e.payload->'attachment_ids' @> ${sql.json([attachmentId])}::jsonb, FALSE)
            ), FALSE) AS has_stored_ref
          FROM sessions s
          WHERE s.session_id = ${scope.id}
          LIMIT 1
        `;
        return evidenceFromRows(scope, rows);
      }
      if (scope.type === "card") {
        const reference = sql.json([{ attachment_id: attachmentId }]);
        const rows = await sql`
          SELECT c.id, c.folder_id,
            (c.attachment_refs @> ${reference}::jsonb
              OR EXISTS (
                SELECT 1 FROM card_reports r
                WHERE r.card_id = c.id AND r.attachment_refs @> ${reference}::jsonb
              )
              OR EXISTS (
                SELECT 1 FROM card_comments m
                WHERE m.card_id = c.id AND m.attachment_refs @> ${reference}::jsonb
              )) AS has_stored_ref
          FROM cards c
          WHERE c.id = ${scope.id}
          LIMIT 1
        `;
        return evidenceFromRows(scope, rows);
      }
      const rows = await sql`
        SELECT id, folder_id,
          (item_type = 'asset' AND item_id = ${attachmentId}) AS has_stored_ref
        FROM board_items
        WHERE id = ${scope.id}
        LIMIT 1
      `;
      return evidenceFromRows(scope, rows);
    },
    async listLegacyCandidateScopes(asset) {
      const sql = await sqlResolver.resolveSql();
      const reference = sql.json([{ attachment_id: asset.id }]);
      const [cards, boardItems] = await Promise.all([
        sql`
          SELECT c.id
          FROM cards c
          WHERE c.attachment_refs @> ${reference}::jsonb
             OR EXISTS (
               SELECT 1 FROM card_reports r
               WHERE r.card_id = c.id AND r.attachment_refs @> ${reference}::jsonb
             )
             OR EXISTS (
               SELECT 1 FROM card_comments m
               WHERE m.card_id = c.id AND m.attachment_refs @> ${reference}::jsonb
             )
        `,
        sql`
          SELECT id
          FROM board_items
          WHERE item_type = 'asset' AND item_id = ${asset.id}
        `,
      ]);
      const scopes: AttachmentScope[] = [
        ...cards.flatMap((row) => {
          const id = nullableString(row.id);
          return id === null ? [] : [{ type: "card" as const, id }];
        }),
        ...boardItems.flatMap((row) => {
          const id = nullableString(row.id);
          return id === null ? [] : [{ type: "board_item" as const, id }];
        }),
      ];
      const registrationScope = attachmentScopeFromRegistrationScope(asset.registrationScope);
      if (registrationScope !== null) scopes.push(registrationScope);
      if (asset.sourceSessionId !== null) {
        scopes.push({ type: "session", id: asset.sourceSessionId });
      }
      const unique = new Map<string, AttachmentScope>();
      for (const scope of scopes) unique.set(`${scope.type}:${scope.id}`, scope);
      return [...unique.values()];
    },
  };
}

function assetFromRow(row: Record<string, unknown>): AttachmentAssetRow {
  const uploadStatus = row.upload_status;
  if (uploadStatus !== "pending" && uploadStatus !== "committed") {
    throw new Error("Invalid attachment upload status");
  }
  return {
    id: requiredString(row.id),
    storageKey: requiredString(row.storage_key),
    storagePurpose: requiredString(row.storage_purpose),
    storageEndpoint: nullableString(row.storage_endpoint),
    storageBucket: nullableString(row.storage_bucket),
    ownerKind: nullableString(row.owner_kind),
    ownerKey: nullableString(row.owner_key),
    registrationScope: row.registration_scope,
    sourceSessionId: nullableString(row.source_session_id),
    originalName: requiredString(row.original_name),
    mimeType: requiredString(row.mime_type),
    byteSize: Number(row.byte_size),
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    checksumSha256: nullableString(row.checksum_sha256),
    uploadStatus,
  };
}

function evidenceFromRows(
  scope: AttachmentScope,
  rows: readonly Record<string, unknown>[],
): AttachmentScopeEvidence | null {
  if (rows.length === 0) return null;
  return {
    scope,
    folderId: nullableString(rows[0]!.folder_id),
    hasStoredRef: rows[0]!.has_stored_ref === true,
  };
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid attachment database row");
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
