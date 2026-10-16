/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentDownloadError,
  downloadAttachmentOriginal,
  downloadLocalAttachmentOriginal,
} from "./attachment-download";

describe("attachment original download", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("checks an asset in the same context, then delegates the un-ranged original GET to the browser", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const clicked: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    const signal = new AbortController().signal;

    await downloadAttachmentOriginal({
      url: "/api/attachments/asset-a/content?context_type=session&context_id=session-a",
      filename: "이미지 원본.png",
      signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/attachments/asset-a/content?context_type=session&context_id=session-a&download=true",
      { method: "HEAD", credentials: "same-origin", signal },
    );
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe("이미지 원본.png");
    const clickedUrl = new URL(clicked[0]!.href);
    expect(clickedUrl.pathname).toBe("/api/attachments/asset-a/content");
    expect(clickedUrl.searchParams.get("context_id")).toBe("session-a");
    expect(clickedUrl.searchParams.get("download")).toBe("true");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("does not HEAD a legacy file route because that route may fall back to a full download", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });

    await downloadAttachmentOriginal({
      url: "/api/attachments/files?nodeId=node-a&path=%2Fincoming%2Fa.txt&context_type=session&context_id=session-a",
      filename: "a.txt",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(1);
    expect(new URL(clicked[0]!.href).searchParams.get("download")).toBe("true");
  });

  it("rejects external or unrecognized URLs without opening them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await expect(downloadAttachmentOriginal({ url: "https://example.com/file", filename: "file" }))
      .rejects.toMatchObject({ code: "ATTACHMENT_DOWNLOAD_UNAVAILABLE" });
    await expect(downloadAttachmentOriginal({ url: "/api/attachments/not-content", filename: "file" }))
      .rejects.toMatchObject({ code: "ATTACHMENT_DOWNLOAD_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("reports a failed asset HEAD check and does not start the browser download", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await expect(downloadAttachmentOriginal({
      url: "/api/attachments/asset-a/content?context_type=session&context_id=session-a",
      filename: "image.png",
    })).rejects.toBeInstanceOf(AttachmentDownloadError);
    expect(click).not.toHaveBeenCalled();
  });

  it("downloads a local File with its original UTF-8 name and releases the object URL", () => {
    const file = new File(["내용"], "자료.txt", { type: "text/plain" });
    const order: string[] = [];
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectURL = vi.fn(() => {
      order.push("create");
      return "blob:http://localhost/local-file";
    });
    const revokeObjectURL = vi.fn(() => order.push("revoke"));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    let clicked: HTMLAnchorElement | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked = this;
      order.push("click");
    });

    try {
      downloadLocalAttachmentOriginal(file);

      expect(createObjectURL).toHaveBeenCalledWith(file);
      expect(clicked?.download).toBe("자료.txt");
      expect(clicked?.href).toBe("blob:http://localhost/local-file");
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/local-file");
      expect(order).toEqual(["create", "click", "revoke"]);
    } finally {
      if (originalCreateObjectURL === undefined) delete (URL as typeof URL & { createObjectURL?: unknown }).createObjectURL;
      else Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
      if (originalRevokeObjectURL === undefined) delete (URL as typeof URL & { revokeObjectURL?: unknown }).revokeObjectURL;
      else Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
    }
  });
});
