import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

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
  cleanupSession(sessionId: string): Promise<number>;
  downloadAttachment(path: string): Promise<DownloadedAttachment>;
}

const MAX_ATTACHMENT_SIZE = 8 * 1024 * 1024;
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

export class FileAttachmentStore implements AttachmentStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  async saveFileForSession(params: SaveSessionFileParams): Promise<SavedAttachment> {
    this.validateFile(params.filename, params.content.length);

    const sessionDir = this.sessionDir(params.sessionId);
    await mkdir(sessionDir, { recursive: true });

    const safeOriginalName = basename(params.filename || "unnamed") || "unnamed";
    const filename = `${Date.now()}_${safeOriginalName}`;
    const filePath = join(sessionDir, filename);
    await writeFile(filePath, params.content);

    return {
      path: resolve(filePath),
      filename,
      size: params.content.length,
      content_type: params.contentType || inferContentType(filename),
    };
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

  async downloadAttachment(path: string): Promise<DownloadedAttachment> {
    const target = resolve(path);
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
      filename: basename(target),
      size: content.length,
    };
  }

  private validateFile(filename: string, size: number): void {
    if (size > MAX_ATTACHMENT_SIZE) {
      throw new AttachmentError(
        `파일이 너무 큽니다 (${Math.floor(size / 1024 / 1024)}MB > ${Math.floor(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB)`,
      );
    }
    const suffix = extname(filename).toLowerCase();
    if (DANGEROUS_EXTENSIONS.has(suffix)) {
      throw new AttachmentError(`보안상 허용되지 않는 파일 형식입니다: ${suffix}`);
    }
  }

  private sessionDir(sessionId: string): string {
    const dir = resolve(join(this.baseDir, sessionId));
    if (!this.isUnderBase(dir)) {
      throw new AttachmentError("session_id가 첨부 디렉토리 밖을 가리킵니다");
    }
    return dir;
  }

  private isUnderBase(path: string): boolean {
    const relative = path.slice(this.baseDir.length);
    return path === this.baseDir || relative.startsWith("/");
  }
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
  }
}

function inferContentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
