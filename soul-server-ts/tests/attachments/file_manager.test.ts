import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileAttachmentStore } from "../../src/attachments/file_manager.js";

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
});
