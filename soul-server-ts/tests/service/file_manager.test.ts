/**
 * FileManager 단위 테스트
 *
 * Python `file_manager.py` 동등 복제 — 각 메서드의 정상·실패·경계 케이스를 검증한다.
 */

import { mkdtemp, rm, symlink, writeFile, readFile, mkdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachmentError, FileManager } from "../../src/service/file_manager.js";
import { MAX_ATTACHMENT_SIZE } from "../../src/constants.js";

let tmpDir: string;
let fm: FileManager;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "fm-test-"));
  fm = new FileManager({ baseDir: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── constructor ───────────────────────────────────────────────────────────

describe("FileManager constructor", () => {
  it("baseDir 미설정 시 throw (env-variables.md §1 정합)", () => {
    expect(() => new FileManager({})).toThrow("baseDir is required");
  });

  it("baseDir 명시 시 정상 생성", () => {
    expect(fm).toBeDefined();
  });

  it("maxSize 미설정 시 MAX_ATTACHMENT_SIZE(8MB) default", () => {
    // getStats로 간접 확인
    const fm2 = new FileManager({ baseDir: tmpDir });
    // 내부 maxSize 직접 노출은 없으므로 validateFile 동작으로 확인
    expect(() => fm2.validateFile("x.txt", MAX_ATTACHMENT_SIZE)).not.toThrow();
    expect(() => fm2.validateFile("x.txt", MAX_ATTACHMENT_SIZE + 1)).toThrow(AttachmentError);
  });
});

// ─── validateFile ───────────────────────────────────────────────────────────

describe("FileManager.validateFile", () => {
  it("크기 정상 + 정상 확장자 → throw 없음", () => {
    expect(() => fm.validateFile("image.png", 1024)).not.toThrow();
  });

  it("크기 초과 → AttachmentError", () => {
    expect(() => fm.validateFile("big.bin", MAX_ATTACHMENT_SIZE + 1)).toThrow(AttachmentError);
    expect(() => fm.validateFile("big.bin", MAX_ATTACHMENT_SIZE + 1)).toThrow("파일이 너무 큽니다");
  });

  it("정확히 MAX_ATTACHMENT_SIZE는 통과", () => {
    expect(() => fm.validateFile("ok.bin", MAX_ATTACHMENT_SIZE)).not.toThrow();
  });

  it("위험 확장자 .env → AttachmentError", () => {
    expect(() => fm.validateFile("secrets.env", 100)).toThrow(AttachmentError);
    expect(() => fm.validateFile("secrets.env", 100)).toThrow("허용되지 않는 파일 형식");
  });

  it("위험 확장자 .pem → AttachmentError", () => {
    expect(() => fm.validateFile("cert.pem", 100)).toThrow(AttachmentError);
  });

  it("위험 확장자 .key → AttachmentError", () => {
    expect(() => fm.validateFile("id_rsa.key", 100)).toThrow(AttachmentError);
  });

  it("위험 확장자 .crt → AttachmentError", () => {
    expect(() => fm.validateFile("root.crt", 100)).toThrow(AttachmentError);
  });

  it("위험 확장자 대문자 .ENV → AttachmentError (case-insensitive)", () => {
    expect(() => fm.validateFile("secrets.ENV", 100)).toThrow(AttachmentError);
  });

  it(".pdf 등 비위험 확장자 → 통과", () => {
    expect(() => fm.validateFile("doc.pdf", 1024)).not.toThrow();
  });
});

// ─── saveFileForSession ─────────────────────────────────────────────────────

describe("FileManager.saveFileForSession", () => {
  it("정상: 파일이 {baseDir}/{sessionId}/{ts_ms}_{filename} 패턴으로 저장", async () => {
    const content = Buffer.from("hello world");
    const result = await fm.saveFileForSession("test.txt", content, "sess-abc");

    expect(result.size).toBe(content.length);
    expect(result.filename).toMatch(/^\d+_test\.txt$/);
    expect(result.path).toContain("sess-abc");
    expect(result.content_type).toBe("text/plain");

    // 실제 파일 존재 확인
    const actual = await readFile(result.path);
    expect(actual).toEqual(content);
  });

  it("content_type: .png → image/png", async () => {
    const result = await fm.saveFileForSession("image.png", Buffer.from("fake"), "s1");
    expect(result.content_type).toBe("image/png");
  });

  it("content_type: 알 수 없는 확장자 → application/octet-stream", async () => {
    const result = await fm.saveFileForSession("data.xyz", Buffer.from("bin"), "s1");
    expect(result.content_type).toBe("application/octet-stream");
  });

  it("크기 초과 → AttachmentError (저장 없음)", async () => {
    const big = Buffer.alloc(MAX_ATTACHMENT_SIZE + 1);
    await expect(fm.saveFileForSession("big.bin", big, "sess-1")).rejects.toThrow(
      AttachmentError,
    );
  });

  it("위험 확장자 → AttachmentError (저장 없음)", async () => {
    await expect(
      fm.saveFileForSession("secret.env", Buffer.from("KEY=val"), "sess-1"),
    ).rejects.toThrow(AttachmentError);
  });

  it("다른 sessionId → 각자 분리된 디렉토리에 저장", async () => {
    await fm.saveFileForSession("a.txt", Buffer.from("a"), "sess-a");
    await fm.saveFileForSession("b.txt", Buffer.from("b"), "sess-b");

    // sess-a, sess-b 각각 존재
    const entries = await import("node:fs/promises").then((m) => m.readdir(tmpDir));
    expect(entries).toContain("sess-a");
    expect(entries).toContain("sess-b");
  });
});

// ─── isUnderBase ────────────────────────────────────────────────────────────

describe("FileManager.isUnderBase", () => {
  it("base 하위 파일 → true", async () => {
    const file = path.join(tmpDir, "sub", "file.txt");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "x");
    expect(await fm.isUnderBase(file)).toBe(true);
  });

  it("외부 절대경로 → false", async () => {
    expect(await fm.isUnderBase("/etc/passwd")).toBe(false);
  });

  it("../traversal → false", async () => {
    const traversal = path.join(tmpDir, "..", "outside.txt");
    expect(await fm.isUnderBase(traversal)).toBe(false);
  });

  it("broken symlink → false (ENOENT on realpath)", async () => {
    const link = path.join(tmpDir, "broken_link");
    await symlink("/nonexistent/target_xyz", link);
    expect(await fm.isUnderBase(link)).toBe(false);
  });

  it("base 안 symlink가 base 내부를 가리키면 → true", async () => {
    const real = path.join(tmpDir, "real.txt");
    await writeFile(real, "content");
    const link = path.join(tmpDir, "link_to_real");
    await symlink(real, link);
    expect(await fm.isUnderBase(link)).toBe(true);
  });

  it("base 안 symlink가 외부를 가리키면 → false", async () => {
    // 외부 파일을 먼저 만들어야 symlink가 broken이 아님
    const externalDir = await mkdtemp(path.join(os.tmpdir(), "ext-"));
    const externalFile = path.join(externalDir, "external.txt");
    await writeFile(externalFile, "ext content");
    const link = path.join(tmpDir, "link_to_external");
    await symlink(externalFile, link);

    const result = await fm.isUnderBase(link);
    await rm(externalDir, { recursive: true, force: true });
    expect(result).toBe(false);
  });
});

// ─── cleanupSession ─────────────────────────────────────────────────────────

describe("FileManager.cleanupSession", () => {
  it("정상: 세션 디렉토리 삭제 + 파일 수 반환", async () => {
    const dir = path.join(tmpDir, "sess-del");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "a.txt"), "a");
    await writeFile(path.join(dir, "b.txt"), "b");

    const count = await fm.cleanupSession("sess-del");
    expect(count).toBe(2);

    // 디렉토리 삭제 확인
    const entries = await import("node:fs/promises").then((m) => m.readdir(tmpDir));
    expect(entries).not.toContain("sess-del");
  });

  it("디렉토리 미존재 → 0 반환 (throw 없음)", async () => {
    const count = await fm.cleanupSession("sess-nonexistent");
    expect(count).toBe(0);
  });

  it("빈 디렉토리 → 0 반환", async () => {
    await mkdir(path.join(tmpDir, "sess-empty"), { recursive: true });
    const count = await fm.cleanupSession("sess-empty");
    expect(count).toBe(0);
  });
});

// ─── cleanupOldFiles ────────────────────────────────────────────────────────

describe("FileManager.cleanupOldFiles", () => {
  it("mtime이 maxAgeHours 이내인 디렉토리는 보존", async () => {
    await mkdir(path.join(tmpDir, "recent"), { recursive: true });
    const cleaned = await fm.cleanupOldFiles(24);
    // 방금 생성한 디렉토리는 24시간 이내 → 삭제 안 함
    expect(cleaned).toBe(0);
    const entries = await import("node:fs/promises").then((m) => m.readdir(tmpDir));
    expect(entries).toContain("recent");
  });

  it("baseDir 미존재 시 0 반환", async () => {
    const fm2 = new FileManager({ baseDir: "/tmp/nonexistent_base_xyz_test" });
    const cleaned = await fm2.cleanupOldFiles(24);
    expect(cleaned).toBe(0);
  });
});

// ─── getStats ────────────────────────────────────────────────────────────────

describe("FileManager.getStats", () => {
  it("빈 디렉토리 → session_count=0, total_files=0", async () => {
    const stats = await fm.getStats();
    expect(stats.base_dir).toBe(tmpDir);
    expect(stats.session_count).toBe(0);
    expect(stats.total_files).toBe(0);
    expect(stats.total_size_mb).toBe(0);
    expect(stats.max_file_size_mb).toBe(8);
  });

  it("파일 저장 후 session_count·total_files 증가", async () => {
    // 1MB 이상 데이터를 써야 total_size_mb > 0 판정 가능
    const bigContent = Buffer.alloc(1024 * 1024, "x"); // 1MB
    await fm.saveFileForSession("a.bin", bigContent, "sess-1");
    await fm.saveFileForSession("b.bin", bigContent, "sess-2");

    const stats = await fm.getStats();
    expect(stats.session_count).toBe(2);
    expect(stats.total_files).toBe(2);
    expect(stats.total_size_mb).toBeGreaterThanOrEqual(2);
  });
});
