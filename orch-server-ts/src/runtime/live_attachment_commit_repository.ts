import type {
  AttachmentCommitRepository,
  AttachmentLegacyAlias,
  OwnedAttachmentPendingInput,
  OwnedAttachmentUpload,
  UploadOwner,
} from "../attachments/attachment_commit_contract.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";

export function createLiveAttachmentCommitRepository(
  sqlResolver: LiveDbSqlResolver,
): AttachmentCommitRepository {
  async function findLegacyAliasForAsset(
    nodeId: string,
    normalizedPath: string,
  ): Promise<AttachmentLegacyAlias | null> {
    const sql = await sqlResolver.resolveSql();
    const rows = await sql`
      SELECT node_id, normalized_path, asset_id, original_path, availability
      FROM attachment_legacy_aliases
      WHERE node_id = ${nodeId} AND normalized_path = ${normalizedPath}
    `;
    return aliasFromRow(rows[0]);
  }

  async function findLegacyAliasForUpload(
    attachmentId: string,
    nodeId: string,
  ): Promise<AttachmentLegacyAlias | null> {
    const sql = await sqlResolver.resolveSql();
    const rows = await sql`
      SELECT node_id, normalized_path, asset_id, original_path, availability
      FROM attachment_legacy_aliases
      WHERE asset_id = ${attachmentId} AND node_id = ${nodeId} AND availability = 'resolved'
      ORDER BY normalized_path
      LIMIT 1
    `;
    return aliasFromRow(rows[0]);
  }

  async function getOwnedUpload(
    attachmentId: string,
    owner: UploadOwner,
  ): Promise<OwnedAttachmentUpload | null> {
    const sql = await sqlResolver.resolveSql();
    const rows = await sql`
      SELECT * FROM file_assets
      WHERE id = ${attachmentId}
        AND owner_kind = ${owner.kind}
        AND owner_key = ${owner.key}
        AND storage_purpose = 'attachment'
    `;
    return attachmentFromRow(rows[0]);
  }

  return {
    async insertOwnedPending(input: OwnedAttachmentPendingInput) {
      const sql = await sqlResolver.resolveSql();
      const registrationScope = input.registration.registrationScope === null
        ? null
        : JSON.stringify(input.registration.registrationScope);
      const rows = await sql`
        INSERT INTO file_assets (
          id, storage_key, storage_purpose, storage_endpoint, storage_bucket,
          owner_kind, owner_key, registration_scope, source_node_id, source_session_id,
          output_command_id, original_name, mime_type, byte_size, checksum_sha256, upload_status
        )
        VALUES (
          ${input.attachmentId}, ${input.storageKey}, 'attachment',
          ${input.location.endpoint}, ${input.location.bucket},
          ${input.owner.kind}, ${input.owner.key}, ${registrationScope}::jsonb,
          ${input.registration.sourceNodeId}, ${input.registration.sourceSessionId},
          ${input.registration.outputCommandId}, ${input.originalName}, ${input.mimeType},
          ${input.byteSize}, NULL, 'pending'
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `;
      const inserted = attachmentFromRow(rows[0]);
      if (inserted !== null) return inserted;
      return getOwnedUpload(input.attachmentId, input.owner);
    },

    getOwnedUpload,

    async setMultipartUploadId(input) {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        UPDATE file_assets
        SET multipart_upload_id = ${input.uploadId}, updated_at = NOW()
        WHERE id = ${input.attachmentId}
          AND owner_kind = ${input.owner.kind}
          AND owner_key = ${input.owner.key}
          AND storage_purpose = 'attachment'
          AND upload_status = 'pending'
          AND multipart_upload_id IS NOT DISTINCT FROM ${input.expectedUploadId}
        RETURNING *
      `;
      return attachmentFromRow(rows[0]);
    },

    async commitVerified(input) {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        UPDATE file_assets
        SET checksum_sha256 = ${input.checksumSha256},
            upload_status = 'committed',
            multipart_upload_id = NULL,
            updated_at = NOW()
        WHERE id = ${input.attachmentId}
          AND owner_kind = ${input.owner.kind}
          AND owner_key = ${input.owner.key}
          AND storage_purpose = 'attachment'
          AND upload_status = 'pending'
          AND byte_size = ${input.expectedByteSize}
        RETURNING *
      `;
      const committed = attachmentFromRow(rows[0]);
      if (committed !== null) return committed;
      const existing = await getOwnedUpload(input.attachmentId, input.owner);
      if (existing?.uploadStatus === "committed"
        && existing.byteSize === input.expectedByteSize
        && existing.checksumSha256 === input.checksumSha256) {
        return existing;
      }
      return null;
    },

    async clearPendingMultipart(input) {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        UPDATE file_assets
        SET multipart_upload_id = NULL, updated_at = NOW()
        WHERE id = ${input.attachmentId}
          AND owner_kind = ${input.owner.kind}
          AND owner_key = ${input.owner.key}
          AND storage_purpose = 'attachment'
          AND upload_status = 'pending'
          AND multipart_upload_id = ${input.expectedUploadId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async findLegacyAliasForAsset(nodeId, normalizedPath) {
      return findLegacyAliasForAsset(nodeId, normalizedPath);
    },

    async findLegacyAliasForUpload(attachmentId, nodeId) {
      return findLegacyAliasForUpload(attachmentId, nodeId);
    },

    async insertLegacyAlias(input) {
      const sql = await sqlResolver.resolveSql();
      await sql`
        INSERT INTO attachment_legacy_aliases (
          node_id, normalized_path, asset_id, original_path, availability
        )
        VALUES (
          ${input.nodeId}, ${input.normalizedPath}, ${input.assetId}, ${input.originalPath}, 'resolved'
        )
        ON CONFLICT (node_id, normalized_path) DO NOTHING
      `;
      const existing = await findLegacyAliasForAsset(input.nodeId, input.normalizedPath);
      return existing?.availability === "resolved" && existing.assetId === input.assetId
        ? existing
        : null;
    },
  };
}

function attachmentFromRow(row: Record<string, unknown> | undefined): OwnedAttachmentUpload | null {
  if (row === undefined) return null;
  const ownerKind = row.owner_kind ?? row.ownerKind;
  const ownerKey = stringValue(row.owner_key ?? row.ownerKey);
  if ((ownerKind !== "user_email" && ownerKind !== "agent_session") || ownerKey === null) return null;
  const uploadStatus = row.upload_status ?? row.uploadStatus;
  if (uploadStatus !== "pending" && uploadStatus !== "committed") return null;
  const id = stringValue(row.id);
  const storageKey = stringValue(row.storage_key ?? row.storageKey);
  const originalName = stringValue(row.original_name ?? row.originalName);
  const mimeType = stringValue(row.mime_type ?? row.mimeType);
  const byteSize = numberValue(row.byte_size ?? row.byteSize);
  const storageEndpoint = stringValue(row.storage_endpoint ?? row.storageEndpoint);
  const storageBucket = stringValue(row.storage_bucket ?? row.storageBucket);
  if (id === null || storageKey === null || originalName === null || mimeType === null
    || byteSize === null || storageEndpoint === null || storageBucket === null) return null;
  const scope = row.registration_scope ?? row.registrationScope ?? null;
  const sourceNodeId = stringOrNull(row.source_node_id ?? row.sourceNodeId);
  const sourceSessionId = stringValue(row.source_session_id ?? row.sourceSessionId);
  const outputCommandId = stringOrNull(row.output_command_id ?? row.outputCommandId);
  const createdAt = row.created_at ?? row.createdAt;
  if (sourceSessionId === null || createdAt === undefined) return null;
  return {
    attachmentId: id,
    storageKey,
    owner: { kind: ownerKind, key: ownerKey },
    registration: {
      registrationScope: scope as OwnedAttachmentUpload["registration"]["registrationScope"],
      sourceNodeId,
      sourceSessionId,
      outputCommandId,
    },
    originalName,
    mimeType,
    byteSize,
    storageEndpoint,
    storageBucket,
    checksumSha256: stringOrNull(row.checksum_sha256 ?? row.checksumSha256),
    uploadStatus,
    multipartUploadId: stringOrNull(row.multipart_upload_id ?? row.multipartUploadId),
    createdAt: createdAt as Date | string,
    garbageCollectedAt: (row.garbage_collected_at ?? row.garbageCollectedAt ?? null) as Date | string | null,
  };
}

function aliasFromRow(row: Record<string, unknown> | undefined): AttachmentLegacyAlias | null {
  if (row === undefined) return null;
  const nodeId = stringValue(row.node_id ?? row.nodeId);
  const normalizedPath = stringValue(row.normalized_path ?? row.normalizedPath);
  const originalPath = stringValue(row.original_path ?? row.originalPath);
  const availability = row.availability;
  if (nodeId === null || normalizedPath === null || originalPath === null
    || (availability !== "resolved" && availability !== "missing")) return null;
  return {
    nodeId,
    normalizedPath,
    assetId: stringOrNull(row.asset_id ?? row.assetId),
    originalPath,
    availability,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
