import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

export interface SaveSessionFileParams {
  sessionId: string;
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface BeginSessionFileUploadParams {
  uploadId: string;
  sessionId: string;
  filename: string;
  contentType?: string;
  expectedSize?: number;
}

export interface AppendSessionFileUploadParams {
  uploadId: string;
  chunk: Buffer;
  chunkIndex: number;
}

export interface FinishSessionFileUploadParams {
  uploadId: string;
}

export interface AbortSessionFileUploadParams {
  uploadId: string;
}

export interface SavedAttachment {
  path: string;
  filename: string;
  size: number;
  content_type: string;
}

export interface DownloadedAttachment {
  content_b64: string;
  content_type: string;
  filename: string;
  size: number;
}

export interface AttachmentStore {
  saveFileForSession(params: SaveSessionFileParams): Promise<SavedAttachment>;
  beginFileUpload(params: BeginSessionFileUploadParams): Promise<{ uploadId: string; next_chunk_index: number }>;
  appendFileUploadChunk(params: AppendSessionFileUploadParams): Promise<{ uploadId: string; chunk_index: number; next_chunk_index: number; size: number }>;
  finishFileUpload(params: FinishSessionFileUploadParams): Promise<SavedAttachment>;
  abortFileUpload(params: AbortSessionFileUploadParams): Promise<boolean>;
  cleanupSession(sessionId: string): Promise<number>;
  downloadAttachment(path: string): Promise<DownloadedAttachment>;
}

const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024;
const DANGEROUS_EXTENSIONS = new Set([
  ".env",
  ".pem",
  ".key",
  ".crt",
  ".p12",
  ".pfx",
  ".jks",
]);

const CONTENT_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

interface PendingUpload {
  uploadId: string;
  sessionDir: string;
  tempPath: string;
  finalPath: string;
  filename: string;
  contentType: string;
  expectedSize?: number;
  size: number;
  nextChunkIndex: number;
}

interface PathOps {
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(target: string): boolean;
}

export class FileAttachmentStore implements AttachmentStore {
  private readonly baseDir: string;
  private readonly pendingUploads = new Map<string, PendingUpload>();
  private readonly uploadOperations = new Map<string, Promise<void>>();

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
  }

  async saveFileForSession(params: SaveSessionFileParams): Promise<SavedAttachment> {
    const safeOriginalName = sanitizeOriginalFilename(params.filename);
    this.validateFile(safeOriginalName, params.content.length);

    const sessionDir = this.sessionDir(params.sessionId);
    await mkdir(sessionDir, { recursive: true });

    const timestamp = new Date().toISOString();
    const { filePath, filename } = await writeUniqueAttachmentFile(
      sessionDir,
      timestamp,
      safeOriginalName,
      params.content,
    );

    return {
      path: path.resolve(filePath),
      filename,
      size: params.content.length,
      content_type: params.contentType || inferContentType(filename),
    };
  }

  async beginFileUpload(
    params: BeginSessionFileUploadParams,
  ): Promise<{ uploadId: string; next_chunk_index: number }> {
    return this.withUploadOperation(params.uploadId, async (safeUploadId) => {
      const safeOriginalName = sanitizeOriginalFilename(params.filename);
      if (params.expectedSize !== undefined) {
        this.validateFile(safeOriginalName, params.expectedSize);
      } else {
        this.validateFile(safeOriginalName, 0);
      }

      if (this.pendingUploads.has(safeUploadId)) {
        throw new AttachmentError("upload_id가 이미 사용 중입니다");
      }

      const sessionDir = this.sessionDir(params.sessionId);
      await mkdir(sessionDir, { recursive: true });

      const timestamp = new Date().toISOString();
      const filename = buildStreamingAttachmentFilename(
        timestamp,
        safeUploadId,
        safeOriginalName,
      );
      const finalPath = path.join(sessionDir, filename);
      const tempPath = path.join(sessionDir, `.upload-${safeUploadId}.tmp`);
      await writeFile(tempPath, Buffer.alloc(0), { flag: "wx" });

      this.pendingUploads.set(safeUploadId, {
        uploadId: safeUploadId,
        sessionDir,
        tempPath,
        finalPath,
        filename,
        contentType: params.contentType || inferContentType(filename),
        expectedSize: params.expectedSize,
        size: 0,
        nextChunkIndex: 0,
      });

      return { uploadId: safeUploadId, next_chunk_index: 0 };
    });
  }

  async appendFileUploadChunk(
    params: AppendSessionFileUploadParams,
  ): Promise<{ uploadId: string; chunk_index: number; next_chunk_index: number; size: number }> {
    return this.withUploadOperation(params.uploadId, async () => {
      const state = this.getPendingUpload(params.uploadId);
      if (params.chunkIndex !== state.nextChunkIndex) {
        throw new AttachmentError(
          `chunk_index 순서가 맞지 않습니다 (${params.chunkIndex} != ${state.nextChunkIndex})`,
        );
      }
      const nextSize = state.size + params.chunk.length;
      try {
        this.validateFile(state.filename, nextSize);
        await appendFile(state.tempPath, params.chunk);
      } catch (err) {
        await this.removePendingUpload(state);
        throw err;
      }

      state.size = nextSize;
      state.nextChunkIndex += 1;
      return {
        uploadId: state.uploadId,
        chunk_index: params.chunkIndex,
        next_chunk_index: state.nextChunkIndex,
        size: state.size,
      };
    });
  }

  async finishFileUpload(params: FinishSessionFileUploadParams): Promise<SavedAttachment> {
    return this.withUploadOperation(params.uploadId, async () => {
      const state = this.getPendingUpload(params.uploadId);
      try {
        if (state.expectedSize !== undefined && state.size !== state.expectedSize) {
          throw new AttachmentError(
            `업로드 크기가 예상과 다릅니다 (${state.size} != ${state.expectedSize})`,
          );
        }
        await rename(state.tempPath, state.finalPath);
        return {
          path: path.resolve(state.finalPath),
          filename: state.filename,
          size: state.size,
          content_type: state.contentType,
        };
      } catch (err) {
        await this.removePendingUpload(state);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new AttachmentError("업로드 임시 파일이 존재하지 않습니다");
        }
        throw err;
      } finally {
        this.pendingUploads.delete(state.uploadId);
      }
    });
  }

  async abortFileUpload(params: AbortSessionFileUploadParams): Promise<boolean> {
    return this.withUploadOperation(params.uploadId, async (safeUploadId) => {
      const state = this.pendingUploads.get(safeUploadId);
      if (!state) return false;
      await this.removePendingUpload(state);
      return true;
    });
  }

  async cleanupSession(sessionId: string): Promise<number> {
    const sessionDir = this.sessionDir(sessionId);
    let filesRemoved = 0;
    try {
      const entries = await readdir(sessionDir, { withFileTypes: true });
      filesRemoved = entries.filter((entry) => entry.isFile()).length;
      await rm(sessionDir, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return 0;
      }
    }
    return filesRemoved;
  }

  async downloadAttachment(attachmentPath: string): Promise<DownloadedAttachment> {
    const target = path.resolve(attachmentPath);
    if (!this.isUnderBase(target)) {
      throw new AttachmentError("path가 첨부 디렉토리 하위가 아닙니다");
    }

    let fileStat;
    try {
      fileStat = await stat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileNotFoundError("파일이 존재하지 않습니다");
      }
      throw err;
    }
    if (!fileStat.isFile()) {
      throw new FileNotFoundError("파일이 존재하지 않습니다");
    }

    const content = await readFile(target);
    return {
      content_b64: content.toString("base64"),
      content_type: inferContentType(target),
      filename: path.basename(target),
      size: content.length,
    };
  }

  private validateFile(filename: string, size: number): void {
    if (!Number.isFinite(size) || !Number.isInteger(size) || size < 0) {
      throw new AttachmentError("파일 크기가 잘못되었습니다");
    }
    if (size > MAX_ATTACHMENT_SIZE) {
      throw new AttachmentError(
        `파일이 너무 큽니다 (${Math.floor(size / 1024 / 1024)}MB > ${Math.floor(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB)`,
      );
    }
    const suffix = path.extname(filename).toLowerCase();
    if (DANGEROUS_EXTENSIONS.has(suffix)) {
      throw new AttachmentError(`보안상 허용되지 않는 파일 형식입니다: ${suffix}`);
    }
  }

  private sessionDir(sessionId: string): string {
    const dir = path.resolve(path.join(this.baseDir, sessionId));
    if (!this.isUnderBase(dir)) {
      throw new AttachmentError("session_id가 첨부 디렉토리 밖을 가리킵니다");
    }
    return dir;
  }

  private isUnderBase(targetPath: string): boolean {
    return isPathUnderBase(this.baseDir, targetPath);
  }

  private getPendingUpload(uploadId: string): PendingUpload {
    const safeUploadId = sanitizeUploadId(uploadId);
    const state = this.pendingUploads.get(safeUploadId);
    if (!state) {
      throw new AttachmentError("upload_id를 찾을 수 없습니다");
    }
    return state;
  }

  private async removePendingUpload(state: PendingUpload): Promise<void> {
    this.pendingUploads.delete(state.uploadId);
    await rm(state.tempPath, { force: true });
  }

  private async withUploadOperation<T>(
    uploadId: string,
    operation: (safeUploadId: string) => Promise<T>,
  ): Promise<T> {
    const safeUploadId = sanitizeUploadId(uploadId);
    const previous = this.uploadOperations.get(safeUploadId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => operation(safeUploadId));
    const tracked = run.then(() => undefined, () => undefined);
    this.uploadOperations.set(safeUploadId, tracked);
    try {
      return await run;
    } finally {
      if (this.uploadOperations.get(safeUploadId) === tracked) {
        this.uploadOperations.delete(safeUploadId);
      }
    }
  }
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
  }
}

function inferContentType(targetPath: string): string {
  return CONTENT_TYPES[path.extname(targetPath).toLowerCase()] ?? "application/octet-stream";
}

function sanitizeOriginalFilename(filename: string): string {
  const base = path.basename((filename || "unnamed").replace(/\\/g, "/"));
  const sanitized = base
    .replace(/[\x00-\x1F\x7F<>:"\/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "_");
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") {
    return "unnamed";
  }
  const stem = sanitized.split(".")[0]?.toUpperCase() ?? "";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    return `_${sanitized}`;
  }
  return sanitized;
}

async function writeUniqueAttachmentFile(
  sessionDir: string,
  timestamp: string,
  originalName: string,
  content: Buffer,
): Promise<{ filePath: string; filename: string }> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const filename = buildAttachmentFilename(timestamp, originalName, attempt);
    const filePath = path.join(sessionDir, filename);
    try {
      await writeFile(filePath, content, { flag: "wx" });
      return { filePath, filename };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new AttachmentError("첨부 파일명 충돌을 해결하지 못했습니다");
}

function buildAttachmentFilename(
  timestamp: string,
  originalName: string,
  attempt: number,
): string {
  if (attempt === 0) return `${timestamp}-${originalName}`;
  const suffix = path.extname(originalName);
  const stem = suffix ? originalName.slice(0, -suffix.length) : originalName;
  return `${timestamp}-${stem}-${attempt}${suffix}`;
}

function buildStreamingAttachmentFilename(
  timestamp: string,
  uploadId: string,
  originalName: string,
): string {
  const suffix = path.extname(originalName);
  const stem = suffix ? originalName.slice(0, -suffix.length) : originalName;
  return `${timestamp}-${stem}-${uploadId}${suffix}`;
}

function sanitizeUploadId(uploadId: string): string {
  const sanitized = (uploadId || "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!sanitized) {
    throw new AttachmentError("upload_id 누락");
  }
  return sanitized;
}

export function isPathUnderBase(
  baseDir: string,
  targetPath: string,
  pathApi: PathOps = path,
): boolean {
  const base = pathApi.resolve(baseDir);
  const target = pathApi.resolve(targetPath);
  const rel = pathApi.relative(base, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !pathApi.isAbsolute(rel));
}
