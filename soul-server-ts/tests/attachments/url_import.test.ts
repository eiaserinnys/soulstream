import { mkdir, mkdtemp, readFile, readdir, rm, truncate } from "node:fs/promises";
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
  const missingExpectedSize = {
    uploadId: input.uploadId,
    sessionId: input.sessionId,
    filename: input.filename,
    contentType: input.contentType,
    downloadUrl: input.downloadUrl,
  };
  const invalidSizeCases = [
    { name: "missing", params: missingExpectedSize },
    { name: "string", params: { ...input, expectedSize: "6" } },
    { name: "negative", params: { ...input, expectedSize: -1 } },
    { name: "fractional", params: { ...input, expectedSize: 1.5 } },
    { name: "non-finite", params: { ...input, expectedSize: Number.NaN } },
  ];
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
  it("imports an empty stream when the expected size is zero", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([])));
    const result = await (await store()).importFileFromUrl({ ...input, expectedSize: 0 });

    expect(result.size).toBe(0);
    expect(result.content_type).toBe("application/zip");
    await expect(readFile(result.path)).resolves.toEqual(Buffer.alloc(0));
    await expect(readdir(join(directory, input.sessionId))).resolves.toEqual([result.filename]);
  });
  it("imports positive-size opaque filenames such as private.pem", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(["key"])));
    const result = await (await store()).importFileFromUrl({
      ...input,
      filename: "private.pem",
      contentType: undefined,
      expectedSize: 3,
    });

    expect(result).toMatchObject({ size: 3, content_type: "application/octet-stream" });
    expect(result.filename).toContain("private-import-one");
    expect(result.filename).toMatch(/\.pem$/);
    await expect(readFile(result.path, "utf8")).resolves.toBe("key");
  });
  it("removes temporary files when the actual size differs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(["abc"])));
    await expect((await store()).importFileFromUrl(input)).rejects.toThrow(/크기/);
    expect(await readdir(join(directory, input.sessionId))).toEqual([]);
  });
  it("rejects a zero-size import when the stream contains bytes and removes the temp file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(["x"])));
    const manager = await store();
    await mkdir(join(directory, input.sessionId), { recursive: true });

    await expect(manager.importFileFromUrl({ ...input, expectedSize: 0 })).rejects.toThrow(/크기/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(await readdir(join(directory, input.sessionId))).toEqual([]);
  });
  it.each(invalidSizeCases)("rejects $name expected sizes before fetching", async ({ params }) => {
    vi.stubGlobal("fetch", vi.fn());
    const manager = await store();

    await expect(manager.importFileFromUrl(params as never)).rejects.toThrow("파일 크기가 잘못되었습니다");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects an import above 5 GiB before fetching", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const manager = await store();

    await expect(manager.importFileFromUrl({ ...input, expectedSize: 5 * 1024 ** 3 + 1 }))
      .rejects.toThrow("파일이 너무 큽니다");
    expect(fetch).not.toHaveBeenCalled();
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
