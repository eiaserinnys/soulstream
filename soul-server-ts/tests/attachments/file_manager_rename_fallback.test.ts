import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const renameGate = vi.hoisted(() => ({
  failOnce: false,
  calls: [] as Array<{ source: string; target: string }>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (source: string, target: string) => {
      renameGate.calls.push({ source, target });
      if (renameGate.failOnce) {
        renameGate.failOnce = false;
        const err = new Error("mock rename ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return actual.rename(source, target);
    }),
  };
});

const { FileAttachmentStore } = await import("../../src/attachments/file_manager.js");

const createdDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `soul-ts-attachments-rename-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  renameGate.failOnce = false;
  renameGate.calls = [];
  await Promise.all(
    createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("FileAttachmentStore finish rename fallback", () => {
  it("copies and unlinks the temp file when Windows rename reports ENOENT while the source still exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T07:00:00.000Z"));
    const dir = await makeTempDir();
    const store = new FileAttachmentStore(dir);

    await store.beginFileUpload({
      uploadId: "rename-race",
      sessionId: "sess-rename-race",
      filename: "사진.png",
      expectedSize: 7,
      contentType: "image/png",
    });
    await store.appendFileUploadChunk({
      uploadId: "rename-race",
      chunkIndex: 0,
      chunk: Buffer.from("payload"),
    });

    await expect(readdir(join(dir, "sess-rename-race"))).resolves.toEqual([
      ".upload-rename-race.tmp",
    ]);
    renameGate.failOnce = true;

    const saved = await store.finishFileUpload({ uploadId: "rename-race" });

    expect(renameGate.calls).toHaveLength(1);
    expect(saved).toMatchObject({
      filename: "2026-06-04T07-00-00.000Z-사진-rename-race.png",
      size: 7,
      content_type: "image/png",
    });
    await expect(readFile(saved.path, "utf8")).resolves.toBe("payload");
    await expect(readdir(join(dir, "sess-rename-race"))).resolves.toEqual([
      saved.filename,
    ]);
  });
});
