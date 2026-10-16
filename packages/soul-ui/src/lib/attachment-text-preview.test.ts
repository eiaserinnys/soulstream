import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentTextPreviewError,
  TEXT_PREVIEW_MAX_BYTES,
  readAttachmentText,
  readLocalAttachmentText,
} from "./attachment-text-preview";

function rangedResponse(
  body: BodyInit,
  byteSize: number,
  start = 0,
  end = (body as Uint8Array).byteLength - 1,
  status = 206,
): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${byteSize}`,
      "Content-Length": String(end - start + 1),
    },
  });
}

describe("attachment text preview", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not fetch an empty attachment", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(readAttachmentText({ url: "/empty.txt", byteSize: 0 })).resolves.toEqual({
      text: "",
      truncated: false,
      bytesRead: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads exactly 1 MiB and marks larger originals as truncated", async () => {
    const bytes = new Uint8Array(TEXT_PREVIEW_MAX_BYTES).fill(0x61);
    const fetchMock = vi.fn(async () => rangedResponse(bytes, TEXT_PREVIEW_MAX_BYTES));
    vi.stubGlobal("fetch", fetchMock);

    await expect(readAttachmentText({ url: "/exact.txt", byteSize: bytes.byteLength })).resolves.toMatchObject({
      truncated: false,
      bytesRead: TEXT_PREVIEW_MAX_BYTES,
    });
    expect(fetchMock).toHaveBeenCalledWith("/exact.txt", expect.objectContaining({
      headers: { Range: "bytes=0-1048575" },
      credentials: "same-origin",
    }));

    fetchMock.mockResolvedValueOnce(rangedResponse(bytes, bytes.byteLength + 1));
    await expect(readAttachmentText({ url: "/large.txt", byteSize: bytes.byteLength + 1 })).resolves.toMatchObject({
      truncated: true,
      bytesRead: TEXT_PREVIEW_MAX_BYTES,
    });
  });

  it("decodes UTF-8 across chunks and strips a leading BOM", async () => {
    const bytes = new TextEncoder().encode("한글");
    const splitBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });
    const splitFetch = vi.fn(async () => rangedResponse(splitBody, bytes.byteLength, 0, bytes.byteLength - 1));
    vi.stubGlobal("fetch", splitFetch);
    await expect(readAttachmentText({ url: "/korean.txt", byteSize: bytes.byteLength })).resolves.toMatchObject({ text: "한글" });

    const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    vi.stubGlobal("fetch", vi.fn(async () => rangedResponse(bomBytes, bomBytes.byteLength)));
    await expect(readAttachmentText({ url: "/bom.txt", byteSize: bomBytes.byteLength })).resolves.toMatchObject({ text: "a" });
  });

  it("omits a final partial code point only when the preview is truncated", async () => {
    const bytes = new Uint8Array(TEXT_PREVIEW_MAX_BYTES).fill(0x61);
    bytes[bytes.length - 1] = 0xe2;
    vi.stubGlobal("fetch", vi.fn(async () => rangedResponse(bytes, bytes.byteLength + 10)));

    const result = await readAttachmentText({ url: "/truncated-korean.txt", byteSize: bytes.byteLength + 10 });
    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBe(TEXT_PREVIEW_MAX_BYTES);
    expect(result.text).toHaveLength(TEXT_PREVIEW_MAX_BYTES - 1);
    expect(result.text.endsWith("\ufffd")).toBe(false);
  });

  it("rejects invalid UTF-8 and ignored or malformed range responses", async () => {
    const invalid = new Uint8Array([0xff]);
    vi.stubGlobal("fetch", vi.fn(async () => rangedResponse(invalid, invalid.byteLength)));
    await expect(readAttachmentText({ url: "/invalid.txt", byteSize: 1 })).rejects.toMatchObject({
      code: "TEXT_PREVIEW_UNSUPPORTED_ENCODING",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not ranged", { status: 200 })));
    await expect(readAttachmentText({ url: "/range.txt", byteSize: 10 })).rejects.toMatchObject({
      code: "TEXT_PREVIEW_INVALID_RESPONSE",
    });
  });

  it("reads local files through the same byte cap", async () => {
    const file = new File([new Uint8Array(TEXT_PREVIEW_MAX_BYTES + 10).fill(0x62)], "large.txt");
    await expect(readLocalAttachmentText(file)).resolves.toMatchObject({
      text: "b".repeat(TEXT_PREVIEW_MAX_BYTES),
      truncated: true,
      bytesRead: TEXT_PREVIEW_MAX_BYTES,
    });
  });

  it("cancels a pending response stream when the request is aborted", async () => {
    const bytes = new Uint8Array([0x61]);
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); },
      pull() { pullCount += 1; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => rangedResponse(body, 2, 0, 1)));
    const controller = new AbortController();
    const pending = readAttachmentText({ url: "/pending.txt", byteSize: 2, signal: controller.signal });
    await vi.waitFor(() => expect(pullCount).toBeGreaterThan(0));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
