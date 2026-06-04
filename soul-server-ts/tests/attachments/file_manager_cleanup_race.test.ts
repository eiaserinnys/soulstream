import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rmGate = vi.hoisted(() => ({
  target: "",
  paused: undefined as undefined | (() => void),
  release: undefined as undefined | (() => void),
  released: Promise.resolve(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: vi.fn(async (target: string, options?: { recursive?: boolean; force?: boolean }) => {
      if (rmGate.target && target === rmGate.target && options?.recursive) {
        rmGate.paused?.();
        await rmGate.released;
      }
      return actual.rm(target, options);
    }),
  };
});

const { FileAttachmentStore } = await import("../../src/attachments/file_manager.js");

const createdDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `soul-ts-attachments-race-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

function armRmGate(target: string): Promise<void> {
  rmGate.target = target;
  rmGate.released = new Promise((resolve) => {
    rmGate.release = resolve;
  });
  return new Promise((resolve) => {
    rmGate.paused = resolve;
  });
}

afterEach(async () => {
  vi.useRealTimers();
  rmGate.release?.();
  rmGate.target = "";
  rmGate.paused = undefined;
  rmGate.release = undefined;
  rmGate.released = Promise.resolve();
  await Promise.all(
    createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("FileAttachmentStore cleanup/upload session race", () => {
  it("does not let an older session cleanup delete a newly started upload temp file", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T01:15:00.000Z"));
    const dir = await makeTempDir();
    const sessionId = "sess-clean-race";
    const sessionDir = join(dir, sessionId);
    const store = new FileAttachmentStore(dir);
    const old = await store.saveFileForSession({
      sessionId,
      filename: "old.txt",
      content: Buffer.from("old"),
    });

    const cleanupPaused = armRmGate(sessionDir);
    const cleanup = store.cleanupSession(sessionId);
    await cleanupPaused;

    const started = store.beginFileUpload({
      uploadId: "race-photo",
      sessionId,
      filename: "사진.png",
      expectedSize: 7,
      contentType: "image/png",
    });
    const chunked = started.then(() =>
      store.appendFileUploadChunk({
        uploadId: "race-photo",
        chunkIndex: 0,
        chunk: Buffer.from("payload"),
      }),
    );

    rmGate.release?.();
    await expect(cleanup).resolves.toBe(1);
    await expect(readFile(old.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(started).resolves.toEqual({
      uploadId: "race-photo",
      next_chunk_index: 0,
    });
    await expect(chunked).resolves.toMatchObject({
      uploadId: "race-photo",
      chunk_index: 0,
      next_chunk_index: 1,
      size: 7,
    });

    const saved = await store.finishFileUpload({ uploadId: "race-photo" });

    expect(saved).toMatchObject({
      filename: "2026-06-04T01:15:00.000Z-사진-race-photo.png",
      size: 7,
      content_type: "image/png",
    });
    await expect(readFile(saved.path, "utf8")).resolves.toBe("payload");
  });
});
