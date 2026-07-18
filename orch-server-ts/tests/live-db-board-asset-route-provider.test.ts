import { describe, expect, it, vi } from "vitest";

import {
  BoardAssetRouteError,
  createLiveBoardAssetRouteProvider,
  resolveLiveBoardAssetStorageFromConfig,
  type BoardAssetRouteProvider,
  type LiveBoardAssetStorage,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  text: string;
  values: unknown[];
};

describe("live DB board asset route provider", () => {
  it("reuses folder and board item providers for access helpers", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("folder_get_all")) return [folderRow()];
      if (text.includes("board_item_get_all")) return [boardItemRow()];
      return [];
    });
    const provider = createProvider(harness);

    await expect(provider.listFolders()).resolves.toEqual([
      expect.objectContaining({ id: "folder-a", parentFolderId: null }),
    ]);
    await expect(provider.getCatalogSnapshot()).resolves.toEqual({
      folders: [expect.objectContaining({ id: "folder-a" })],
      boardItems: [expect.objectContaining({ id: "task-card" })],
    });
  });

  it("treats missing or partial R2 config as disabled storage", async () => {
    const harness = createSqlHarness();
    const provider = createProvider(harness, { storage: null });

    await expect(
      provider.initFileAsset({
        folderId: "folder-a",
        name: "photo.png",
        mimeType: "image/png",
        byteSize: 123,
      }),
    ).rejects.toMatchObject(
      new BoardAssetRouteError(
        "BOARD_ASSET_STORAGE_UNAVAILABLE",
        "board asset storage is not configured",
        503,
      ),
    );
    await expect(resolveLiveBoardAssetStorageFromConfig({})).resolves.toBeNull();
    await expect(
      resolveLiveBoardAssetStorageFromConfig({
        r2_board_assets_bucket: "board-assets",
      }),
    ).resolves.toBeNull();
  });

  it("initializes single uploads with Python quota, safe key and pending DB semantics", async () => {
    const storage = createStorage();
    const harness = createSqlHarness((text) => {
      if (text.includes("COALESCE(SUM(byte_size)")) return [{ total: "1000" }];
      if (text.includes("INSERT INTO file_assets")) {
        return [
          fileAssetRow({
            id: "asset-1",
            storage_key: "folders/folder-a/assets/asset-1/unsafe_name.png",
            original_name: " unsafe/name.png ",
            mime_type: "image/png",
            byte_size: "1234",
          }),
        ];
      }
      return [];
    });
    const provider = createProvider(harness, {
      assetIdGenerator: () => "asset-1",
      storage,
    });

    await expect(
      provider.initFileAsset({
        folderId: "folder-a",
        name: " unsafe/name.png ",
        mimeType: "image/png",
        byteSize: 1234,
      }),
    ).resolves.toEqual({
      assetId: "asset-1",
      asset: expect.objectContaining({
        id: "asset-1",
        storageKey: "folders/folder-a/assets/asset-1/unsafe_name.png",
        originalName: " unsafe/name.png ",
        byteSize: 1234,
        uploadStatus: "pending",
      }),
      storageKey: "folders/folder-a/assets/asset-1/unsafe_name.png",
      uploadMode: "single",
      uploadUrl: "https://r2.example.test/put/folders%2Ffolder-a%2Fassets%2Fasset-1%2Funsafe_name.png",
      headers: { "Content-Type": "image/png" },
    });
    expect(storage.createPresignedPutUrl).toHaveBeenCalledWith({
      storageKey: "folders/folder-a/assets/asset-1/unsafe_name.png",
      mimeType: "image/png",
      expiresSeconds: 900,
    });
    expect(harness.normalizedCalls()).toEqual([
      expect.stringContaining("UPDATE file_assets SET garbage_collected_at = NOW()"),
      expect.stringContaining("SELECT COALESCE(SUM(byte_size), 0)::BIGINT AS total"),
      expect.stringContaining("INSERT INTO file_assets"),
    ]);
    expect(harness.calls[0]?.values[0]).toEqual(new Date("2026-07-09T00:00:00.000Z"));
    expect(harness.calls[2]?.values).toEqual([
      "asset-1",
      "folders/folder-a/assets/asset-1/unsafe_name.png",
      " unsafe/name.png ",
      "image/png",
      1234,
      null,
    ]);
  });

  it("initializes multipart uploads above the Python threshold", async () => {
    const storage = createStorage();
    const harness = createSqlHarness((text) => {
      if (text.includes("COALESCE(SUM(byte_size)")) return [{ total: "0" }];
      if (text.includes("INSERT INTO file_assets")) {
        return [
          fileAssetRow({
            id: "asset-multi",
            storage_key: "containers/task/rb-1/assets/asset-multi/clip.mov",
            original_name: "clip.mov",
            mime_type: "video/quicktime",
            byte_size: String(5 * 1024 * 1024 + 1),
            multipart_upload_id: "upload-1",
          }),
        ];
      }
      return [];
    });
    const provider = createProvider(harness, {
      assetIdGenerator: () => "asset-multi",
      storage,
    });

    await expect(
      provider.initFileAsset({
        folderId: "folder-a",
        containerKind: "task",
        containerId: "rb-1",
        name: "clip.mov",
        mimeType: "video/quicktime",
        byteSize: 5 * 1024 * 1024 + 1,
      }),
    ).resolves.toMatchObject({
      assetId: "asset-multi",
      storageKey: "containers/task/rb-1/assets/asset-multi/clip.mov",
      uploadMode: "multipart",
      uploadId: "upload-1",
      partSize: 5 * 1024 * 1024,
      parts: [
        { partNumber: 1, uploadUrl: "https://r2.example.test/part/1" },
        { partNumber: 2, uploadUrl: "https://r2.example.test/part/2" },
      ],
    });
    expect(storage.createMultipartUpload).toHaveBeenCalledWith({
      storageKey: "containers/task/rb-1/assets/asset-multi/clip.mov",
      mimeType: "video/quicktime",
      byteSize: 5 * 1024 * 1024 + 1,
      partSize: 5 * 1024 * 1024,
      expiresSeconds: 900,
    });
    expect(harness.calls[2]?.values.at(-1)).toBe("upload-1");
  });

  it("rejects size and daily quota before allocating storage", async () => {
    const storage = createStorage();
    const quotaHarness = createSqlHarness((text) =>
      text.includes("COALESCE(SUM(byte_size)")
        ? [{ total: String(5 * 1024 * 1024 * 1024) }]
        : [],
    );
    const quotaProvider = createProvider(quotaHarness, { storage });
    const sizeProvider = createProvider(createSqlHarness(), { storage });

    await expect(
      sizeProvider.initFileAsset({
        folderId: "folder-a",
        name: "huge.bin",
        mimeType: "application/octet-stream",
        byteSize: 200 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow("file size exceeds board asset limit");
    await expect(
      quotaProvider.initFileAsset({
        folderId: "folder-a",
        name: "photo.png",
        mimeType: "image/png",
        byteSize: 1,
      }),
    ).rejects.toThrow("daily board asset quota exceeded");
    expect(storage.createPresignedPutUrl).not.toHaveBeenCalled();
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("commits uploads with multipart completion, head validation, DB metadata and signed URL projection", async () => {
    const storage = createStorage({
      head: { byteSize: 2048, mimeType: "image/png; charset=binary" },
    });
    const harness = createSqlHarness((text) => {
      if (text.includes("SELECT * FROM file_assets WHERE id")) {
        return [
          fileAssetRow({
            id: "asset-1",
            storage_key: "folders/folder-a/assets/asset-1/photo.png",
            mime_type: "image/png",
            byte_size: "2048",
            multipart_upload_id: "upload-1",
          }),
        ];
      }
      if (text.includes("UPDATE file_assets")) {
        return [
          fileAssetRow({
            id: "asset-1",
            storage_key: "folders/folder-a/assets/asset-1/photo.png",
            mime_type: "image/png",
            byte_size: "2048",
            upload_status: "committed",
            width: 640,
            height: 480,
          }),
        ];
      }
      if (text.includes("INSERT INTO board_items")) {
        return [
          boardItemRow({
            id: "asset:asset-1",
            item_type: "asset",
            item_id: "asset-1",
            x: 40,
            y: 80,
            metadata: {
              assetId: "asset-1",
              storageKey: "folders/folder-a/assets/asset-1/photo.png",
              originalName: "photo.png",
              mimeType: "image/png",
              byteSize: 2048,
              width: 640,
              height: 480,
              durationSeconds: null,
            },
          }),
        ];
      }
      return [];
    });
    const provider = createProvider(harness, { storage });

    await expect(
      provider.commitFileAsset({
        folderId: "folder-a",
        assetId: "asset-1",
        x: 41,
        y: 79,
        width: 640,
        height: 480,
        parts: [
          { partNumber: 2, etag: "etag-2" },
          { partNumber: 1, etag: "etag-1" },
        ],
      }),
    ).resolves.toEqual({
      asset: expect.objectContaining({ id: "asset-1", uploadStatus: "committed" }),
      boardItem: expect.objectContaining({
        id: "asset:asset-1",
        itemType: "asset",
        x: 40,
        y: 80,
        metadata: expect.objectContaining({
          storageKey: "folders/folder-a/assets/asset-1/photo.png",
          signedUrl: "https://r2.example.test/get/folders%2Ffolder-a%2Fassets%2Fasset-1%2Fphoto.png",
        }),
      }),
    });
    expect(storage.completeMultipartUpload).toHaveBeenCalledWith({
      storageKey: "folders/folder-a/assets/asset-1/photo.png",
      uploadId: "upload-1",
      parts: [
        { partNumber: 2, etag: "etag-2" },
        { partNumber: 1, etag: "etag-1" },
      ],
    });
    expect(harness.calls.find((call) => call.text.includes("UPDATE file_assets"))?.values).toEqual([
      "asset-1",
      640,
      480,
      null,
    ]);
    expect(harness.calls.find((call) => call.text.includes("INSERT INTO board_items"))?.values).toEqual([
      "asset:asset-1",
      "folder-a",
      "folder",
      "folder-a",
      "asset-1",
      40,
      80,
      JSON.stringify({
        assetId: "asset-1",
        storageKey: "folders/folder-a/assets/asset-1/photo.png",
        originalName: "photo.png",
        mimeType: "image/png",
        byteSize: 2048,
        width: 640,
        height: 480,
        durationSeconds: null,
      }),
    ]);
  });
});

function createProvider(
  harness: ReturnType<typeof createSqlHarness>,
  options: {
    storage?: LiveBoardAssetStorage | null;
    assetIdGenerator?: () => string;
  } = {},
): BoardAssetRouteProvider {
  return createLiveBoardAssetRouteProvider({
    sqlResolver: {
      resolveSql: async () => harness.sql,
      close: async () => undefined,
    },
    folderProvider: {
      listFolders: async () => [serializeFolderRow(folderRow())],
      listSessionAssignments: async () => ({}),
      createFolder: async () => ({}),
      updateFolder: async () => undefined,
      deleteFolder: async () => undefined,
      reorderFolders: async () => undefined,
      getFolderCounts: async () => new Map(),
    },
    boardItemProvider: {
      listFolders: async () => [serializeFolderRow(folderRow())],
      listBoardItems: async () => [],
      resolveBoardContainerFolderId: async (container) =>
        container.kind === "folder" ? container.id : "folder-a",
      getCatalogSnapshot: async () => ({
        folders: [serializeFolderRow(folderRow())],
        boardItems: [serializeBoardItemRow(boardItemRow())],
      }),
    },
    storage: options.storage,
    assetIdGenerator: options.assetIdGenerator,
    now: () => new Date("2026-07-10T00:00:00.000Z"),
  });
}

function createStorage(
  overrides: { head?: { byteSize: number; mimeType?: string | null } } = {},
): LiveBoardAssetStorage {
  return {
    createPresignedPutUrl: vi.fn(async ({ storageKey }) =>
      `https://r2.example.test/put/${encodeURIComponent(storageKey)}`,
    ),
    createMultipartUpload: vi.fn(async () => ({
      uploadId: "upload-1",
      partSize: 5 * 1024 * 1024,
      parts: [
        { partNumber: 1, uploadUrl: "https://r2.example.test/part/1" },
        { partNumber: 2, uploadUrl: "https://r2.example.test/part/2" },
      ],
    })),
    completeMultipartUpload: vi.fn(async () => undefined),
    headObject: vi.fn(async () => overrides.head ?? { byteSize: 1234, mimeType: "image/png" }),
    createPresignedGetUrl: vi.fn(async ({ storageKey }) =>
      `https://r2.example.test/get/${encodeURIComponent(storageKey)}`,
    ),
  };
}

function createSqlHarness(
  rowsFor: (text: string, values: unknown[]) => readonly Record<string, unknown>[] = () => [],
) {
  const calls: SqlCall[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return rowsFor(text, values);
  }) as unknown as LivePostgresSql;

  return {
    sql,
    calls,
    normalizedCalls: () =>
      calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
  };
}

function folderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "folder-a",
    name: "Folder",
    sort_order: 1,
    parent_folder_id: null,
    settings: {},
    ...overrides,
  };
}

function boardItemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-card",
    folder_id: "folder-a",
    container_kind: "folder",
    container_id: "folder-a",
    membership_kind: "primary",
    source_task_item_id: null,
    item_type: "task",
    item_id: "rb-1",
    x: 20,
    y: 40,
    metadata: {},
    created_at: new Date("2026-07-09T00:00:00.000Z"),
    updated_at: new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

function fileAssetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "asset-1",
    storage_key: "folders/folder-a/assets/asset-1/photo.png",
    original_name: "photo.png",
    mime_type: "image/png",
    byte_size: "1234",
    width: null,
    height: null,
    duration_seconds: null,
    checksum_sha256: null,
    upload_status: "pending",
    multipart_upload_id: null,
    garbage_collected_at: null,
    created_at: new Date("2026-07-09T00:00:00.000Z"),
    updated_at: new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

function serializeFolderRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    sortOrder: Number(row.sort_order ?? 0),
    parentFolderId: typeof row.parent_folder_id === "string" ? row.parent_folder_id : null,
    settings: {},
  };
}

function serializeBoardItemRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    folderId: String(row.folder_id),
    containerKind: String(row.container_kind ?? "folder"),
    containerId: String(row.container_id ?? row.folder_id),
    membershipKind: String(row.membership_kind ?? "primary"),
    sourceTaskItemId: row.source_task_item_id as string | null,
    itemType: String(row.item_type),
    itemId: String(row.item_id),
    x: Number(row.x ?? 0),
    y: Number(row.y ?? 0),
    metadata: row.metadata as Record<string, unknown>,
  };
}
