import { randomUUID } from "node:crypto";

import {
  BoardAssetRouteError,
  type BoardAssetCommitInput,
  type BoardAssetContainerKind,
  type BoardAssetInitInput,
  type BoardAssetRouteProvider,
} from "../board/board_asset_routes.js";
import type { BoardItemRecord, BoardItemRouteProvider } from "../board/board_item_routes.js";
import type { LiveConfigProviderBoundary } from "./live_provider_dependencies.js";
import type { LiveDbSqlResolver, LivePostgresSql } from "./live_db_sql.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";
import {
  resolveLiveBoardAssetStorageFromConfig,
  type LiveBoardAssetStorage,
} from "./live_board_asset_storage.js";

export type CreateLiveBoardAssetRouteProviderOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
  readonly folderProvider: LiveFolderProvider;
  readonly boardItemProvider: BoardItemRouteProvider;
  readonly storage?: LiveBoardAssetStorage | null;
  readonly configProvider?: LiveConfigProviderBoundary;
  readonly assetIdGenerator?: () => string;
  readonly now?: () => Date;
};

type FileAssetRecord = {
  readonly id: string;
  readonly storageKey: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly checksumSha256: string | null;
  readonly uploadStatus: string | null;
  readonly multipartUploadId: string | null;
  readonly garbageCollectedAt: string | null;
  readonly createdAt: string | undefined;
  readonly updatedAt: string | undefined;
};

const BOARD_GRID_SIZE = 20;
const SINGLE_FILE_LIMIT_BYTES = 200 * 1024 * 1024;
const DAILY_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
const MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;
const MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;
const PUT_URL_TTL_SECONDS = 15 * 60;
const GET_URL_TTL_SECONDS = 10 * 60;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export function createLiveBoardAssetRouteProvider(
  options: CreateLiveBoardAssetRouteProviderOptions,
): BoardAssetRouteProvider {
  const assetIdGenerator = options.assetIdGenerator ?? randomUUID;
  const now = options.now ?? (() => new Date());

  return {
    listFolders: options.folderProvider.listFolders,
    getCatalogSnapshot: options.boardItemProvider.getCatalogSnapshot,
    async initFileAsset(input) {
      const storage = await resolveStorage(options);
      validateInitSize(input);
      const sql = await options.sqlResolver.resolveSql();
      await markStalePendingFileAssets(sql, now());
      await assertDailyQuota(sql, input.byteSize);

      const assetId = assetIdGenerator();
      const containerId = input.containerId ?? input.folderId;
      const storageKey = assetStorageKey(
        input.folderId,
        input.containerKind ?? "folder",
        containerId,
        assetId,
        safeStorageName(input.name),
      );
      if (input.byteSize > MULTIPART_THRESHOLD_BYTES) {
        const multipart = await storage.createMultipartUpload({
          storageKey,
          mimeType: input.mimeType,
          byteSize: input.byteSize,
          partSize: MULTIPART_PART_SIZE_BYTES,
          expiresSeconds: PUT_URL_TTL_SECONDS,
        });
        const asset = await createPendingAsset(sql, input, assetId, storageKey, multipart.uploadId);
        return {
          assetId,
          asset,
          storageKey,
          uploadMode: "multipart",
          uploadId: multipart.uploadId,
          partSize: multipart.partSize,
          parts: multipart.parts,
        };
      }

      const asset = await createPendingAsset(sql, input, assetId, storageKey, null);
      return {
        assetId,
        asset,
        storageKey,
        uploadMode: "single",
        uploadUrl: await storage.createPresignedPutUrl({
          storageKey,
          mimeType: input.mimeType,
          expiresSeconds: PUT_URL_TTL_SECONDS,
        }),
        headers: { "Content-Type": input.mimeType },
      };
    },
    async commitFileAsset(input) {
      const storage = await resolveStorage(options);
      const sql = await options.sqlResolver.resolveSql();
      const asset = await getFileAsset(sql, input.assetId);
      if (asset === null) throw new Error(`file asset not found: ${input.assetId}`);
      await completeMultipartIfNeeded(storage, asset, input.parts);
      await validateUploadedObject(storage, asset);
      const result = await commitAssetTransaction(sql, input);
      return {
        asset: result.asset,
        boardItem: await withAssetUrl(storage, result.boardItem),
      };
    },
  };
}

async function resolveStorage(
  options: CreateLiveBoardAssetRouteProviderOptions,
): Promise<LiveBoardAssetStorage> {
  if (options.storage !== undefined) {
    if (options.storage !== null) return options.storage;
    throw storageUnavailable();
  }
  const config = await options.configProvider?.getConfig();
  const storage = config === undefined
    ? null
    : await resolveLiveBoardAssetStorageFromConfig(config);
  if (storage === null) throw storageUnavailable();
  return storage;
}

function storageUnavailable(): BoardAssetRouteError {
  return new BoardAssetRouteError(
    "BOARD_ASSET_STORAGE_UNAVAILABLE",
    "board asset storage is not configured",
    503,
  );
}

function validateInitSize(input: BoardAssetInitInput): void {
  if (input.byteSize > SINGLE_FILE_LIMIT_BYTES) {
    throw new Error("file size exceeds board asset limit");
  }
}

async function markStalePendingFileAssets(
  sql: LivePostgresSql,
  currentTime: Date,
): Promise<void> {
  const staleBefore = new Date(currentTime.getTime() - PENDING_TTL_MS);
  await sql`
    UPDATE file_assets SET garbage_collected_at = NOW(),
        updated_at = NOW()
    WHERE upload_status = 'pending'
      AND garbage_collected_at IS NULL
      AND created_at < ${staleBefore}
  `;
}

async function assertDailyQuota(
  sql: LivePostgresSql,
  byteSize: number,
): Promise<void> {
  const rows = await sql`
    SELECT COALESCE(SUM(byte_size), 0)::BIGINT AS total
    FROM file_assets
    WHERE created_at >= date_trunc('day', NOW())
      AND garbage_collected_at IS NULL
  `;
  const total = numberValue(rows[0]?.total) ?? 0;
  if (total + byteSize > DAILY_LIMIT_BYTES) {
    throw new Error("daily board asset quota exceeded");
  }
}

async function createPendingAsset(
  sql: LivePostgresSql,
  input: BoardAssetInitInput,
  assetId: string,
  storageKey: string,
  uploadId: string | null,
): Promise<FileAssetRecord> {
  const rows = await sql`
    INSERT INTO file_assets (
      id, storage_key, original_name, mime_type, byte_size, multipart_upload_id
    )
    VALUES (
      ${assetId}, ${storageKey}, ${input.name}, ${input.mimeType}, ${input.byteSize}, ${uploadId}
    )
    RETURNING *
  `;
  return requireFileAsset(rows[0], assetId);
}

async function getFileAsset(
  sql: LivePostgresSql,
  assetId: string,
): Promise<FileAssetRecord | null> {
  const rows = await sql`
    SELECT * FROM file_assets WHERE id = ${assetId}
  `;
  return fileAssetFromRow(rows[0]);
}

async function completeMultipartIfNeeded(
  storage: LiveBoardAssetStorage,
  asset: FileAssetRecord,
  parts: BoardAssetCommitInput["parts"],
): Promise<void> {
  if (asset.multipartUploadId === null) return;
  await storage.completeMultipartUpload({
    storageKey: asset.storageKey,
    uploadId: asset.multipartUploadId,
    parts,
  });
}

async function validateUploadedObject(
  storage: LiveBoardAssetStorage,
  asset: FileAssetRecord,
): Promise<void> {
  const head = await storage.headObject({ storageKey: asset.storageKey });
  if (head.byteSize !== asset.byteSize) {
    throw new Error("uploaded object size mismatch");
  }
  const uploadedType = head.mimeType?.split(";")[0];
  const expectedType = asset.mimeType.split(";")[0];
  if (uploadedType !== undefined && uploadedType !== expectedType) {
    throw new Error("uploaded object content type mismatch");
  }
}

async function commitAssetTransaction(
  sql: LivePostgresSql,
  input: BoardAssetCommitInput,
): Promise<{ readonly asset: FileAssetRecord; readonly boardItem: BoardItemRecord }> {
  return withTransaction(sql, async (tx) => {
    const assetRows = await tx`
      WITH commit_input AS (
        SELECT
          ${input.assetId}::text AS asset_id,
          ${input.width ?? null}::integer AS width,
          ${input.height ?? null}::integer AS height,
          ${input.durationSeconds ?? null}::double precision AS duration_seconds
      )
      UPDATE file_assets
      SET upload_status = 'committed',
          width = COALESCE(commit_input.width, file_assets.width),
          height = COALESCE(commit_input.height, file_assets.height),
          duration_seconds = COALESCE(commit_input.duration_seconds, file_assets.duration_seconds),
          updated_at = NOW()
      FROM commit_input
      WHERE file_assets.id = commit_input.asset_id
        AND garbage_collected_at IS NULL
      RETURNING file_assets.*
    `;
    const asset = requireFileAsset(assetRows[0], input.assetId);
    const containerKind = input.containerKind ?? "folder";
    const containerId = input.containerId ?? input.folderId;
    const metadata = assetMetadata(asset);
    const itemRows = await tx`
      INSERT INTO board_items (
        id, folder_id, container_kind, container_id, membership_kind,
        item_type, item_id, x, y, metadata
      )
      VALUES (
        ${`asset:${input.assetId}`}, ${input.folderId}, ${containerKind}, ${containerId},
        'primary', 'asset', ${input.assetId}, ${snap(input.x)}, ${snap(input.y)},
        ${JSON.stringify(metadata)}::jsonb
      )
      ON CONFLICT (id) DO UPDATE
      SET folder_id = EXCLUDED.folder_id,
          container_kind = EXCLUDED.container_kind,
          container_id = EXCLUDED.container_id,
          membership_kind = EXCLUDED.membership_kind,
          x = EXCLUDED.x,
          y = EXCLUDED.y,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      RETURNING *
    `;
    return { asset, boardItem: requireBoardItem(itemRows[0]) };
  });
}

type LivePostgresSqlWithTransaction = LivePostgresSql & {
  readonly begin?: <T>(callback: (sql: LivePostgresSql) => Promise<T>) => Promise<T>;
};

async function withTransaction<T>(
  sql: LivePostgresSql,
  callback: (sql: LivePostgresSql) => Promise<T>,
): Promise<T> {
  const begin = (sql as LivePostgresSqlWithTransaction).begin;
  if (typeof begin === "function") {
    const runInTransaction = begin as (
      this: LivePostgresSql,
      callback: (sql: LivePostgresSql) => Promise<T>,
    ) => Promise<T>;
    return runInTransaction.call(sql, callback);
  }
  return callback(sql);
}

async function withAssetUrl(
  storage: LiveBoardAssetStorage,
  item: BoardItemRecord,
): Promise<BoardItemRecord> {
  const metadata = objectValue(item.metadata);
  const storageKey = stringValue(metadata.storageKey);
  if (item.itemType !== "asset" || storageKey === null) return item;
  return {
    ...item,
    metadata: {
      ...metadata,
      signedUrl: await storage.createPresignedGetUrl({
        storageKey,
        expiresSeconds: GET_URL_TTL_SECONDS,
      }),
    },
  };
}

function assetMetadata(asset: FileAssetRecord): Record<string, unknown> {
  return {
    assetId: asset.id,
    storageKey: asset.storageKey,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    width: asset.width,
    height: asset.height,
    durationSeconds: asset.durationSeconds,
  };
}

function safeStorageName(name: string): string {
  const base = name
    .trim()
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_")
    .replace(/^[ .]+|[ .]+$/g, "");
  return base.length > 0 ? base : "file";
}

function assetStorageKey(
  folderId: string,
  containerKind: BoardAssetContainerKind,
  containerId: string,
  assetId: string,
  safeName: string,
): string {
  if (containerKind === "folder" && containerId === folderId) {
    return `folders/${folderId}/assets/${assetId}/${safeName}`;
  }
  return `containers/${containerKind}/${containerId}/assets/${assetId}/${safeName}`;
}

function snap(value: number): number {
  return Math.round(value / BOARD_GRID_SIZE) * BOARD_GRID_SIZE;
}

function requireFileAsset(
  row: Record<string, unknown> | undefined,
  assetId: string,
): FileAssetRecord {
  const asset = fileAssetFromRow(row);
  if (asset === null) throw new Error(`file asset not found: ${assetId}`);
  return asset;
}

function fileAssetFromRow(
  row: Record<string, unknown> | undefined,
): FileAssetRecord | null {
  if (row === undefined) return null;
  const id = stringValue(row.id);
  const storageKey = stringValue(row.storage_key ?? row.storageKey);
  const originalName = stringValue(row.original_name ?? row.originalName);
  const mimeType = stringValue(row.mime_type ?? row.mimeType);
  const byteSize = numberValue(row.byte_size ?? row.byteSize);
  if (
    id === null ||
    storageKey === null ||
    originalName === null ||
    mimeType === null ||
    byteSize === undefined
  ) {
    return null;
  }
  return {
    id,
    storageKey,
    originalName,
    mimeType,
    byteSize,
    width: numberOrNull(row.width),
    height: numberOrNull(row.height),
    durationSeconds: numberOrNull(row.duration_seconds ?? row.durationSeconds),
    checksumSha256: stringOrNull(row.checksum_sha256 ?? row.checksumSha256),
    uploadStatus: stringOrNull(row.upload_status ?? row.uploadStatus),
    multipartUploadId: stringOrNull(row.multipart_upload_id ?? row.multipartUploadId),
    garbageCollectedAt: timestampOrNull(
      row.garbage_collected_at ?? row.garbageCollectedAt,
    ),
    createdAt: timestampOrUndefined(row.created_at ?? row.createdAt),
    updatedAt: timestampOrUndefined(row.updated_at ?? row.updatedAt),
  };
}

function requireBoardItem(row: Record<string, unknown> | undefined): BoardItemRecord {
  const id = stringValue(row?.id);
  const folderId = stringValue(row?.folder_id ?? row?.folderId);
  const itemType = stringValue(row?.item_type ?? row?.itemType);
  const itemId = stringValue(row?.item_id ?? row?.itemId);
  if (id === null || folderId === null || itemType === null || itemId === null) {
    throw new Error("board item insert did not return a valid row");
  }
  const item: BoardItemRecord = {
    id,
    folderId,
    containerKind: stringValue(row?.container_kind ?? row?.containerKind) ?? "folder",
    containerId: stringValue(row?.container_id ?? row?.containerId) ?? folderId,
    membershipKind:
      stringValue(row?.membership_kind ?? row?.membershipKind) ?? "primary",
    sourceTaskItemId: stringOrNull(
      row?.source_task_item_id ?? row?.sourceTaskItemId,
    ),
    itemType,
    itemId,
    x: numberValue(row?.x) ?? 0,
    y: numberValue(row?.y) ?? 0,
    metadata: objectValue(row?.metadata),
  };
  const createdAt = timestampOrUndefined(row?.created_at ?? row?.createdAt);
  if (createdAt !== undefined) item.createdAt = createdAt;
  const updatedAt = timestampOrUndefined(row?.updated_at ?? row?.updatedAt);
  if (updatedAt !== undefined) item.updatedAt = updatedAt;
  return item;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : numberValue(value) ?? null;
}

function timestampOrUndefined(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : undefined;
}

function timestampOrNull(value: unknown): string | null {
  return timestampOrUndefined(value) ?? null;
}
