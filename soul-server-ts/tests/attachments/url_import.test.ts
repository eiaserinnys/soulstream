import { mkdtemp, readFile, readdir, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileAttachmentStore } from "../../src/attachments/file_manager.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

// Uses the existing file-manager temp-directory fixture pattern; fetch is
// replaced at the external boundary so the real stream and filesystem run.
describe("R2 attachment streaming import", () => {
  let directory: string;
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const input = {
    uploadId: "import-one", sessionId: "session-one", filename: "자료.zip",
    contentType: "application/zip", expectedSize: 6,
    downloadUrl: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/bucket/object",
  };
  async function store() {
    directory = await mkdtemp(join(tmpdir(), "attachment-import-"));
    return new FileAttachmentStore(directory);
  }
  function response(chunks: string[]) {
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }));
  }
  it("streams chunks to a local file and preserves the attachment result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(["abc", "def"])));
    const result = await (await store()).importFileFromUrl(input);
    expect(await readFile(result.path, "utf8")).toBe("abcdef");
    expect(result).toMatchObject({ size: 6, content_type: "application/zip" });
    expect(await readdir(join(directory, input.sessionId))).toEqual([result.filename]);
    expect(fetch).toHaveBeenCalledWith(input.downloadUrl, expect.objectContaining({ redirect: "error" }));
  });
  it("removes temporary files when the actual size differs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(["abc"])));
    await expect((await store()).importFileFromUrl(input)).rejects.toThrow(/크기/);
    expect(await readdir(join(directory, input.sessionId))).toEqual([]);
  });
  it("rejects a non-R2 URL before sending a request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect((await store()).importFileFromUrl({ ...input, downloadUrl: "https://example.com/file" })).rejects.toThrow(/R2/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cleans a partial import when the existing abort command cancels it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("abc")); },
    }))));
    const manager = await store();
    const importing = manager.importFileFromUrl(input);
    const rejection = expect(importing).rejects.toThrow();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(await manager.abortFileUpload({ uploadId: input.uploadId })).toBe(true);
    await rejection;
    expect(await readdir(join(directory, input.sessionId))).toEqual([]);
  });
  it("rejects a large file before the legacy download can read it into memory", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(["abcdef"])));
    const manager = await store();
    const saved = await manager.importFileFromUrl(input);
    // Sparse fixture: exercises the real stat guard without loading file bytes.
    await truncate(saved.path, 100 * 1024 ** 2 + 1);
    vi.mocked(readFile).mockRejectedValueOnce(new Error("unexpected whole-file read"));
    await expect(manager.downloadAttachment(saved.path)).rejects.toThrow(/100MiB/);
  });
});
