/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const heic2any = vi.fn();
vi.mock("heic2any", () => ({ default: (...args: unknown[]) => heic2any(...args) }));

import { MarkdownImage } from "./MarkdownImage";

describe("MarkdownImage", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    heic2any.mockReset();
  });

  function image(): HTMLImageElement {
    return container.querySelector("img")!;
  }

  async function flush() {
    await act(async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
  }

  it("marks SVG sources so they get the light picture background", async () => {
    await act(async () => root.render(<MarkdownImage src="/vector.svg" alt="도식" mimeType="image/svg+xml" />));

    expect(image().getAttribute("src")).toBe("/vector.svg");
    expect(image().getAttribute("data-image-format")).toBe("svg");
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("object")).toBeNull();
  });

  it("decodes a HEIC source lazily when the browser cannot paint it", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["heic-bytes"], { type: "image/heic" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:decoded"),
      revokeObjectURL: vi.fn(),
    });
    heic2any.mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
    const onError = vi.fn();

    await act(async () => root.render(
      <MarkdownImage src="/photo.heic" alt="사진" mimeType="image/heic" onError={onError} />,
    ));
    expect(image().getAttribute("src")).toBe("/photo.heic");

    await act(async () => {
      image().dispatchEvent(new Event("error"));
    });
    await flush();

    expect(heic2any).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/photo.heic", { credentials: "same-origin" });
    expect(image().getAttribute("src")).toBe("blob:decoded");
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports the source when the HEIC decoder fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["heic-bytes"], { type: "image/heic" }),
    })));
    heic2any.mockRejectedValue(new Error("no decoder"));
    const onError = vi.fn();

    await act(async () => root.render(
      <MarkdownImage src="/photo.heic" alt="사진" mimeType="image/heic" onError={onError} />,
    ));
    await act(async () => {
      image().dispatchEvent(new Event("error"));
    });
    await flush();

    expect(onError).toHaveBeenCalledWith("/photo.heic");
  });

  it("reads the SVG format from the address query and path parameter", async () => {
    await act(async () => root.render(
      <MarkdownImage src="/fixture.svg?width=480&height=320" alt="쿼리" />,
    ));
    expect(image().getAttribute("data-image-format")).toBe("svg");

    await act(async () => root.render(
      <MarkdownImage src="/api/attachments/files?nodeId=node&path=chart.svg&context_type=session" alt="경로" />,
    ));
    expect(image().getAttribute("data-image-format")).toBe("svg");

    await act(async () => root.render(
      <MarkdownImage src="/vector.svg#page=2" alt="조각" />,
    ));
    expect(image().getAttribute("data-image-format")).toBe("svg");
  });

  it("decodes HEIC from a files address before any MIME metadata arrives", async () => {
    const address = "/api/attachments/files?nodeId=node&path=IMG_0412.HEIC&context_type=session";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["heic-bytes"], { type: "image/heic" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:decoded-heic"),
      revokeObjectURL: vi.fn(),
    });
    heic2any.mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
    const onError = vi.fn();

    await act(async () => root.render(
      <MarkdownImage src={address} alt="사진" onError={onError} />,
    ));
    await act(async () => {
      image().dispatchEvent(new Event("error"));
    });
    await flush();

    expect(heic2any).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(address, { credentials: "same-origin" });
    expect(image().getAttribute("src")).toBe("blob:decoded-heic");
    expect(onError).not.toHaveBeenCalled();
  });

  it("ignores the query and fragment when judging a HEIC address", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["heic-bytes"], { type: "image/heic" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:decoded-query"),
      revokeObjectURL: vi.fn(),
    });
    heic2any.mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
    const onError = vi.fn();

    await act(async () => root.render(
      <MarkdownImage src="/photo.HEIC?download=1#page=2" alt="사진" onError={onError} />,
    ));
    await act(async () => {
      image().dispatchEvent(new Event("error"));
    });
    await flush();

    expect(heic2any).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a raster source that cannot be painted", async () => {
    heic2any.mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
    const onError = vi.fn();
    await act(async () => root.render(<MarkdownImage src="/photo.png" alt="사진" onError={onError} />));

    await act(async () => {
      image().dispatchEvent(new Event("error"));
    });
    await flush();

    expect(heic2any).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("/photo.png");
  });
});
