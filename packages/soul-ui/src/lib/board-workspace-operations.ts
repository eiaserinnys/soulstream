import type { CatalogBoardItem, MarkdownDocument } from "../shared/types";

export interface BoardWorkspaceApiConfig {
  updateBoardItemPositionUrl: (id: string) => string;
  createMarkdownDocumentUrl: string;
  initBoardAssetUrl: (folderId: string) => string;
  commitBoardAssetUrl: (folderId: string, assetId: string) => string;
}

export interface CreateMarkdownDocumentRequest {
  folderId: string;
  title: string;
  body: string;
  x: number;
  y: number;
}

export interface CreateMarkdownDocumentResponse {
  document: MarkdownDocument;
  boardItem: CatalogBoardItem;
}

export interface UploadBoardAssetInput {
  folderId: string;
  file: File;
  x: number;
  y: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  onProgress?: (progress: number) => void;
}

export interface BoardAssetCommitResponse {
  asset: Record<string, unknown>;
  boardItem: CatalogBoardItem;
}

interface BoardAssetInitPart {
  partNumber: number;
  uploadUrl: string;
}

interface BoardAssetInitResponse {
  assetId: string;
  uploadMode: "single" | "multipart";
  uploadUrl?: string;
  headers?: Record<string, string>;
  uploadId?: string;
  partSize?: number;
  parts?: BoardAssetInitPart[];
}

interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface BoardWorkspaceOperations {
  updateBoardItemPosition: (boardItemId: string, x: number, y: number) => Promise<void>;
  createMarkdownDocument: (
    input: CreateMarkdownDocumentRequest,
  ) => Promise<CreateMarkdownDocumentResponse>;
  uploadBoardAsset: (input: UploadBoardAssetInput) => Promise<BoardAssetCommitResponse>;
}

function uploadBlobWithProgress(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress?.(event.loaded, event.total);
    };
    xhr.onerror = () => reject(new Error("Board asset upload failed"));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Board asset upload failed: ${xhr.status}`));
        return;
      }
      resolve(xhr.getResponseHeader("ETag"));
    };
    xhr.send(blob);
  });
}

export function createBoardWorkspaceOperations(
  config: BoardWorkspaceApiConfig,
): BoardWorkspaceOperations {
  async function updateBoardItemPosition(
    boardItemId: string,
    x: number,
    y: number,
  ): Promise<void> {
    const res = await fetch(config.updateBoardItemPositionUrl(boardItemId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y }),
    });
    if (!res.ok) {
      throw new Error(`Update board item position failed: ${res.status}`);
    }
  }

  async function createMarkdownDocument(
    input: CreateMarkdownDocumentRequest,
  ): Promise<CreateMarkdownDocumentResponse> {
    const res = await fetch(config.createMarkdownDocumentUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw new Error(`Create markdown document failed: ${res.status}`);
    }
    return await res.json() as CreateMarkdownDocumentResponse;
  }

  async function initBoardAsset(input: UploadBoardAssetInput): Promise<BoardAssetInitResponse> {
    const res = await fetch(config.initBoardAssetUrl(input.folderId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.file.name,
        mime: input.file.type || "application/octet-stream",
        size: input.file.size,
      }),
    });
    if (!res.ok) {
      throw new Error(`Initialize board asset upload failed: ${res.status}`);
    }
    return await res.json() as BoardAssetInitResponse;
  }

  async function uploadBoardAssetFile(
    file: File,
    init: BoardAssetInitResponse,
    onProgress?: (progress: number) => void,
  ): Promise<UploadedPart[]> {
    if (init.uploadMode === "multipart") {
      const partSize = init.partSize ?? 5 * 1024 * 1024;
      const parts = init.parts ?? [];
      const uploaded: UploadedPart[] = [];
      let completedBytes = 0;
      for (const part of parts) {
        const start = (part.partNumber - 1) * partSize;
        const end = Math.min(file.size, start + partSize);
        const blob = file.slice(start, end);
        const etag = await uploadBlobWithProgress(part.uploadUrl, blob, {}, (loaded) => {
          onProgress?.(((completedBytes + loaded) / Math.max(1, file.size)) * 100);
        });
        completedBytes += blob.size;
        uploaded.push({ partNumber: part.partNumber, etag: etag ?? "" });
        onProgress?.((completedBytes / Math.max(1, file.size)) * 100);
      }
      return uploaded;
    }

    if (!init.uploadUrl) {
      throw new Error("Initialize board asset upload failed: missing uploadUrl");
    }
    await uploadBlobWithProgress(init.uploadUrl, file, init.headers ?? {}, (loaded, total) => {
      onProgress?.((loaded / Math.max(1, total)) * 100);
    });
    onProgress?.(100);
    return [];
  }

  async function commitBoardAsset(
    input: UploadBoardAssetInput,
    assetId: string,
    parts: UploadedPart[],
  ): Promise<BoardAssetCommitResponse> {
    const res = await fetch(config.commitBoardAssetUrl(input.folderId, assetId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        durationSeconds: input.durationSeconds,
        parts,
      }),
    });
    if (!res.ok) {
      throw new Error(`Commit board asset upload failed: ${res.status}`);
    }
    return await res.json() as BoardAssetCommitResponse;
  }

  async function uploadBoardAsset(input: UploadBoardAssetInput): Promise<BoardAssetCommitResponse> {
    input.onProgress?.(0);
    const init = await initBoardAsset(input);
    const parts = await uploadBoardAssetFile(input.file, init, input.onProgress);
    return await commitBoardAsset(input, init.assetId, parts);
  }

  return { updateBoardItemPosition, createMarkdownDocument, uploadBoardAsset };
}
