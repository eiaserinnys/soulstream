/**
 * FileManager — 첨부 파일 관리
 *
 * Python `soul-server/src/soul_server/service/file_manager.py` 동등 복제.
 * 디스크 구조: `{baseDir}/{sessionId}/{ts_ms}_{filename}`
 * 검증: 크기 ≤ MAX_ATTACHMENT_SIZE(8MB), 확장자 ∉ DANGEROUS_EXTENSIONS
 *
 * design-principles §1·§3·§4 정합:
 * - baseDir 미설정 시 throw (코드 default 없음)
 * - isUnderBase: realpath 기반 symlink 목적지 검증
 * - 정본은 이 클래스 하나
 */

import { mkdir, realpath, rm, stat, readFile, writeFile, readdir } from "node:fs/promises";
import * as path from "node:path";

import { MAX_ATTACHMENT_SIZE, DANGEROUS_EXTENSIONS } from "../constants.js";

/** Python `AttachmentError` 동등 */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

export interface SaveResult {
  /** 노드 절대경로 (Python `save_file_for_session` 반환 정합) */
  path: string;
  /** 타임스탬프 prefix가 붙은 저장 파일명 (`{ts_ms}_{filename}`) */
  filename: string;
  /** bytes */
  size: number;
  content_type: string;
}

export interface Stats {
  base_dir: string;
  /** 세션(하위 디렉토리) 수 */
  session_count: number;
  total_files: number;
  total_size_mb: number;
  max_file_size_mb: number;
}

/**
 * 파일 확장자 → MIME 타입 inline map (핵심 형식).
 * mime-types 패키지 없이 동작하도록 내장. Python `mimetypes.guess_type` 정합 fallback 포함.
 */
const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".py": "text/x-python",
  ".ts": "text/typescript",
  ".js": "text/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".xml": "application/xml",
};

export function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

export class FileManager {
  private readonly baseDir: string;
  private readonly maxSize: number;

  /**
   * @param opts.baseDir - 첨부 파일 저장 기본 디렉토리. 미설정 시 throw.
   *   (env-variables.md §1: 코드 default 금지 — 호출자가 명시적으로 결정)
   * @param opts.maxSize - 최대 파일 크기 (bytes). default: MAX_ATTACHMENT_SIZE
   */
  constructor(opts: { baseDir?: string; maxSize?: number } = {}) {
    if (!opts.baseDir) {
      throw new Error(
        "FileManager: baseDir is required. Set INCOMING_FILE_DIR env or pass baseDir explicitly.",
      );
    }
    this.baseDir = opts.baseDir;
    this.maxSize = opts.maxSize ?? MAX_ATTACHMENT_SIZE;
  }

  /** baseDir 하위의 세션별 디렉토리 경로 (생성 포함) */
  async getSessionDir(sessionId: string): Promise<string> {
    const dir = path.join(this.baseDir, sessionId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * absPath가 baseDir 하위에 위치하는지 검사 (directory traversal 방지).
   *
   * Python `is_under_base` 정합:
   * - fs.realpath로 symlink 목적지를 resolve한 뒤 base 하위인지 판정
   * - broken symlink, base 밖을 가리키는 symlink 둘 다 거부
   * - ValueError(relative_to 실패) / OSError(resolve 실패) 모두 false 반환
   */
  async isUnderBase(absPath: string): Promise<boolean> {
    try {
      const [resolvedTarget, resolvedBase] = await Promise.all([
        realpath(absPath),
        realpath(this.baseDir),
      ]);
      // path.relative가 '..'로 시작하면 base 하위 아님
      const rel = path.relative(resolvedBase, resolvedTarget);
      return !rel.startsWith("..") && !path.isAbsolute(rel);
    } catch {
      // ENOENT (broken symlink·존재하지 않는 경로), EACCES 등 — 보수적으로 거부
      return false;
    }
  }

  /**
   * 파일 검증.
   *
   * @throws {AttachmentError} 크기 초과 또는 위험 확장자
   */
  validateFile(filename: string, size: number): void {
    if (size > this.maxSize) {
      const sizeMb = Math.floor(size / 1024 / 1024);
      const maxMb = Math.floor(this.maxSize / 1024 / 1024);
      throw new AttachmentError(
        `파일이 너무 큽니다 (${sizeMb}MB > ${maxMb}MB)`,
      );
    }
    const ext = path.extname(filename).toLowerCase();
    if ((DANGEROUS_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new AttachmentError(
        `보안상 허용되지 않는 파일 형식입니다: ${ext}`,
      );
    }
  }

  /**
   * 세션 생성 전 파일 업로드.
   *
   * 디스크 구조: `{baseDir}/{sessionId}/{ts_ms}_{filename}`
   * Python `save_file_for_session` (L207-251) 정합.
   *
   * @returns SaveResult — path는 노드 절대경로
   * @throws {AttachmentError} 검증 실패
   */
  async saveFileForSession(
    filename: string,
    content: Buffer,
    sessionId: string,
  ): Promise<SaveResult> {
    this.validateFile(filename, content.length);

    const sessionDir = await this.getSessionDir(sessionId);
    const timestamp = Date.now();
    const safeName = `${timestamp}_${filename}`;
    const filePath = path.join(sessionDir, safeName);

    await writeFile(filePath, content);

    return {
      path: path.resolve(filePath),
      filename: safeName,
      size: content.length,
      content_type: guessMimeType(filename),
    };
  }

  /**
   * 세션 첨부 파일 정리.
   *
   * Python `cleanup_session` (L253-273) 정합.
   *
   * @returns 삭제된 파일 수 (디렉토리 미존재 시 0)
   */
  async cleanupSession(sessionId: string): Promise<number> {
    const sessionDir = path.join(this.baseDir, sessionId);
    let filesRemoved = 0;
    try {
      const entries = await readdir(sessionDir);
      for (const entry of entries) {
        try {
          const s = await stat(path.join(sessionDir, entry));
          if (s.isFile()) filesRemoved++;
        } catch {
          // stat 실패 — 카운트만 skip
        }
      }
      await rm(sessionDir, { recursive: true, force: true });
    } catch (err: unknown) {
      // ENOENT: 디렉토리 미존재 → 0 반환
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return 0;
      // 기타 오류도 보수적으로 0 반환 (Python 정합)
      return 0;
    }
    return filesRemoved;
  }

  /**
   * 오래된 첨부 파일 정리.
   *
   * Python `cleanup_old_files` (L298-328) 정합.
   * baseDir 바로 아래 디렉토리(세션 디렉토리)를 순회하며 mtime 기준으로 제거.
   *
   * @param maxAgeHours - 최대 보관 시간 (hours). default: 24
   * @returns 삭제된 디렉토리 수
   */
  async cleanupOldFiles(maxAgeHours = 24): Promise<number> {
    const maxAgeMs = maxAgeHours * 3600 * 1000;
    const now = Date.now();
    let cleaned = 0;

    let entries: string[];
    try {
      entries = await readdir(this.baseDir);
    } catch {
      return 0;
    }

    for (const entry of entries) {
      const dirPath = path.join(this.baseDir, entry);
      try {
        const s = await stat(dirPath);
        if (!s.isDirectory()) continue;
        if (now - s.mtimeMs > maxAgeMs) {
          await rm(dirPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch {
        continue;
      }
    }
    return cleaned;
  }

  /** 첨부 파일 통계 (Python `get_stats` L330-351 정합) */
  async getStats(): Promise<Stats> {
    let totalFiles = 0;
    let totalSize = 0;
    let sessionCount = 0;

    let entries: string[] = [];
    try {
      entries = await readdir(this.baseDir);
    } catch {
      // baseDir 미존재 등
    }

    for (const entry of entries) {
      const dirPath = path.join(this.baseDir, entry);
      try {
        const s = await stat(dirPath);
        if (!s.isDirectory()) continue;
        sessionCount++;
        const files = await readdir(dirPath);
        for (const file of files) {
          try {
            const fs = await stat(path.join(dirPath, file));
            if (fs.isFile()) {
              totalFiles++;
              totalSize += fs.size;
            }
          } catch {
            // skip
          }
        }
      } catch {
        continue;
      }
    }

    return {
      base_dir: this.baseDir,
      session_count: sessionCount,
      total_files: totalFiles,
      total_size_mb: Math.round((totalSize / (1024 * 1024)) * 100) / 100,
      max_file_size_mb: Math.floor(this.maxSize / (1024 * 1024)),
    };
  }
}
