import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import {
  FileAttachmentStore,
  isPathUnderBase,
} from "../../src/attachments/file_manager.js";

const createdDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `soul-ts-attachments-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("FileAttachmentStore", () => {
  it("stores files with ISO timestamp prefix and sanitized original filename", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:45:30.123Z"));
    const dir = await makeTempDir();
    const store = new FileAttachmentStore(dir);

    const saved = await store.saveFileForSession({
      sessionId: "sess-1",
      filename: "..\\위험/이미지 \0\n 이름.png",
      content: Buffer.from("bytes"),
      contentType: "image/png",
    });

    expect(saved.filename).toBe("2026-06-01T00:45:30.123Z-이미지 __ 이름.png");
    expect(saved.path).toBe(join(dir, "sess-1", saved.filename));
    await expect(readFile(saved.path, "utf8")).resolves.toBe("bytes");
    expect(saved.content_type).toBe("image/png");
  });

  it("does not overwrite same-timestamp same-name attachments", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:45:30.123Z"));
    const dir = await makeTempDir();
    const store = new FileAttachmentStore(dir);

    const first = await store.saveFileForSession({
      sessionId: "sess-1",
      filename: "report.txt",
      content: Buffer.from("first"),
    });
    const second = await store.saveFileForSession({
      sessionId: "sess-1",
      filename: "report.txt",
      content: Buffer.from("second"),
    });

    expect(first.filename).toBe("2026-06-01T00:45:30.123Z-report.txt");
    expect(second.filename).toBe("2026-06-01T00:45:30.123Z-report-1.txt");
    await expect(readFile(first.path, "utf8")).resolves.toBe("first");
    await expect(readFile(second.path, "utf8")).resolves.toBe("second");
  });

  it("treats Windows backslash child paths as under the attachment base", () => {
    const base = "D:\\soulstream\\.local\\incoming";

    expect(
      isPathUnderBase(base, "D:\\soulstream\\.local\\incoming\\sess-1", win32),
    ).toBe(true);
    expect(
      isPathUnderBase(base, "D:\\soulstream\\.local\\incoming", win32),
    ).toBe(true);
    expect(
      isPathUnderBase(base, "D:\\soulstream\\.local\\incoming-other\\sess-1", win32),
    ).toBe(false);
    expect(
      isPathUnderBase(base, "D:\\soulstream\\.local\\incoming\\..\\outside", win32),
    ).toBe(false);
    expect(isPathUnderBase(base, "D:\\evil", win32)).toBe(false);
  });

  it("allows attachments larger than the legacy 8MB limit and reports 100MB errors", async () => {
    const dir = await makeTempDir();
    const store = new FileAttachmentStore(dir);

    const saved = await store.saveFileForSession({
      sessionId: "sess-large",
      filename: "large.bin",
      content: Buffer.alloc(9 * 1024 * 1024, 1),
    });

    expect(saved.size).toBe(9 * 1024 * 1024);
    await expect(readFile(saved.path)).resolves.toHaveLength(9 * 1024 * 1024);

    await expect(
      store.beginFileUpload({
        uploadId: "too-large",
        sessionId: "sess-large",
        filename: "huge.bin",
        expectedSize: 101 * 1024 * 1024,
      }),
    ).rejects.toThrow("100MB");
  });

  it("sanitizes Windows reserved filename characters while preserving CJK text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:45:30.123Z"));
    const dir = await makeTempDir();
    const store = new FileAttachmentStore(dir);

    const saved = await store.saveFileForSession({
      sessionId: "sess-cjk",
      filename: "深入浅出:即梦?知乎.zip ",
      content: Buffer.from("zip"),
    });

    expect(saved.filename).toBe("2026-06-01T00:45:30.123Z-深入浅出_即梦_知乎.zip_");
    await expect(readFile(saved.path, "utf8")).resolves.toBe("zip");
  });

  it("streams chunks to a temp file and renames only on finish", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:45:30.123Z"));
    const dir = await makeTempDir();
    const store = new FileAttachmentStore(dir);

    await store.beginFileUpload({
      uploadId: "upload-a",
      sessionId: "sess-stream",
      filename: "report.txt",
      expectedSize: 11,
      contentType: "text/plain",
    });
    await store.appendFileUploadChunk({
      uploadId: "upload-a",
      chunkIndex: 0,
      chunk: Buffer.from("hello "),
    });
    await store.appendFileUploadChunk({
      uploadId: "upload-a",
      chunkIndex: 1,
      chunk: Buffer.from("world"),
    });

    const beforeFinish = await readdir(join(dir, "sess-stream"));
    expect(beforeFinish).toEqual([".upload-upload-a.tmp"]);

    const saved = await store.finishFileUpload({ uploadId: "upload-a" });

    expect(saved).toMatchObject({
      filename: "2026-06-01T00:45:30.123Z-report-upload-a.txt",
      size: 11,
      content_type: "text/plain",
    });
    await expect(readFile(saved.path, "utf8")).resolves.toBe("hello world");
    await expect(readdir(join(dir, "sess-stream"))).resolves.toEqual([saved.filename]);
  });

  it("serializes chunk and finish behind a started upload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:45:30.123Z"));
    const dir = await makeTempDir();
    const store = new FileAttachmentStore(dir);

    const started = store.beginFileUpload({
      uploadId: "race-upload",
      sessionId: "sess-race",
      filename: "photo.png",
      expectedSize: 11,
      contentType: "image/png",
    });
    const chunked = store.appendFileUploadChunk({
      uploadId: "race-upload",
      chunkIndex: 0,
      chunk: Buffer.from("hello world"),
    });
    const finished = store.finishFileUpload({ uploadId: "race-upload" });

    await expect(started).resolves.toEqual({
      uploadId: "race-upload",
      next_chunk_index: 0,
    });
    await expect(chunked).resolves.toMatchObject({
      uploadId: "race-upload",
      chunk_index: 0,
      next_chunk_index: 1,
      size: 11,
    });
    const saved = await finished;

    expect(saved).toMatchObject({
      filename: "2026-06-01T00:45:30.123Z-photo-race-upload.png",
      size: 11,
      content_type: "image/png",
    });
    await expect(readFile(saved.path, "utf8")).resolves.toBe("hello world");
    await expect(readdir(join(dir, "sess-race"))).resolves.toEqual([saved.filename]);
  });

  it("removes temp chunks when an upload is aborted", async () => {
    const dir = await makeTempDir();
    const store = new FileAttachmentStore(dir);

    await store.beginFileUpload({
      uploadId: "abort-me",
      sessionId: "sess-abort",
      filename: "partial.txt",
    });
    await store.appendFileUploadChunk({
      uploadId: "abort-me",
      chunkIndex: 0,
      chunk: Buffer.from("partial"),
    });

    await expect(store.abortFileUpload({ uploadId: "abort-me" })).resolves.toBe(true);
    await expect(readdir(join(dir, "sess-abort"))).resolves.toEqual([]);
  });

  it("keeps finish and abort for the same upload ordered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:45:30.123Z"));
    const dir = await makeTempDir();
    const store = new FileAttachmentStore(dir);

    await store.beginFileUpload({
      uploadId: "finish-first",
      sessionId: "sess-finish-first",
      filename: "photo.png",
      expectedSize: 4,
    });
    await store.appendFileUploadChunk({
      uploadId: "finish-first",
      chunkIndex: 0,
      chunk: Buffer.from("done"),
    });

    const finished = store.finishFileUpload({ uploadId: "finish-first" });
    const aborted = store.abortFileUpload({ uploadId: "finish-first" });

    const saved = await finished;
    await expect(aborted).resolves.toBe(false);
    await expect(readFile(saved.path, "utf8")).resolves.toBe("done");
    await expect(readdir(join(dir, "sess-finish-first"))).resolves.toEqual([saved.filename]);
  });

  it("keeps concurrent same-name streaming uploads distinct", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:45:30.123Z"));
    const dir = await makeTempDir();
    const store = new FileAttachmentStore(dir);

    await Promise.all([
      store.beginFileUpload({
        uploadId: "up-a",
        sessionId: "sess-concurrent",
        filename: "same.txt",
      }),
      store.beginFileUpload({
        uploadId: "up-b",
        sessionId: "sess-concurrent",
        filename: "same.txt",
      }),
    ]);
    await Promise.all([
      store.appendFileUploadChunk({
        uploadId: "up-a",
        chunkIndex: 0,
        chunk: Buffer.from("A"),
      }),
      store.appendFileUploadChunk({
        uploadId: "up-b",
        chunkIndex: 0,
        chunk: Buffer.from("B"),
      }),
    ]);

    const [a, b] = await Promise.all([
      store.finishFileUpload({ uploadId: "up-a" }),
      store.finishFileUpload({ uploadId: "up-b" }),
    ]);

    expect(a.filename).not.toBe(b.filename);
    await expect(readFile(a.path, "utf8")).resolves.toBe("A");
    await expect(readFile(b.path, "utf8")).resolves.toBe("B");
  });

  it("streams attachments over 50MB through the temp upload lifecycle", async () => {
    const dir = await makeTempDir();
    const store = new FileAttachmentStore(dir);
    const chunk = Buffer.alloc(17 * 1024 * 1024, 7);

    await store.beginFileUpload({
      uploadId: "large-stream",
      sessionId: "sess-large-stream",
      filename: "large.bin",
      expectedSize: chunk.length * 3,
    });
    await store.appendFileUploadChunk({ uploadId: "large-stream", chunkIndex: 0, chunk });
    await store.appendFileUploadChunk({ uploadId: "large-stream", chunkIndex: 1, chunk });
    await store.appendFileUploadChunk({ uploadId: "large-stream", chunkIndex: 2, chunk });

    const saved = await store.finishFileUpload({ uploadId: "large-stream" });

    expect(saved.size).toBe(51 * 1024 * 1024);
    await expect(readFile(saved.path)).resolves.toHaveLength(51 * 1024 * 1024);
    await expect(readdir(join(dir, "sess-large-stream"))).resolves.toEqual([saved.filename]);
  });
});
