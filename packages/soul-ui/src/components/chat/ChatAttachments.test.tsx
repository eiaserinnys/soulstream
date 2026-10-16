/** @vitest-environment jsdom */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileAttachmentPreview } from "../FileAttachmentPreview";
import { ChatAttachments } from "./ChatAttachments";
import type { ChatAttachmentItem } from "../../lib/chat-attachment-model";

const sessionContext = { type: "session" as const, id: "review-session" };

function attachment(key: string, overrides: Partial<ChatAttachmentItem> = {}): ChatAttachmentItem {
  return {
    key,
    name: `${key}.png`,
    mimeType: "image/png",
    byteSize: 1024,
    previewKind: "image",
    availability: "ready",
    previewUrl: `/${key}.png`,
    originalUrl: `/${key}.png?download=true`,
    legacySources: [],
    source: { kind: "asset", attachmentId: key, context: sessionContext },
    ...overrides,
  };
}

describe("ChatAttachments", () => {
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
  });

  it("keeps image and file groups in their original full-item positions", async () => {
    const items = [
      attachment("first"),
      attachment("notes", {
        mimeType: "text/plain",
        byteSize: 25,
        previewKind: "text",
        previewUrl: "/notes.txt",
        name: "notes.txt",
      }),
      attachment("second"),
      attachment("archive", {
        mimeType: "application/zip",
        byteSize: null,
        previewKind: "info",
        previewUrl: null,
        name: "archive.zip",
      }),
    ];
    const onOpen = vi.fn();
    await act(async () => root.render(<ChatAttachments items={items} role="user" onOpen={onOpen} />));

    const imageRun = container.querySelector<HTMLElement>("[data-chat-image-run]");
    expect(imageRun?.getAttribute("data-chat-image-role")).toBe("user");
    expect([...container.querySelectorAll("[data-chat-image-index]")].map(node => node.getAttribute("data-chat-image-index")))
      .toEqual(["0", "2"]);
    expect([...container.querySelectorAll("[data-chat-attachment-index]")].map(node => node.getAttribute("data-chat-attachment-index")))
      .toEqual(["1", "3"]);
    expect(container.textContent).not.toContain("0 B");

    await act(async () => container.querySelector<HTMLButtonElement>('[data-chat-attachment-index="1"]')?.click());
    expect(onOpen).toHaveBeenLastCalledWith(1, expect.any(HTMLButtonElement));
    await act(async () => container.querySelector<HTMLImageElement>('[data-chat-image-index="2"] img')?.click());
    expect(onOpen).toHaveBeenLastCalledWith(2, expect.any(HTMLImageElement));
  });

  it("keeps SVG and HEIC items in the info rows even when marked as images", async () => {
    const items = [
      attachment("vector", { name: "vector.svg", mimeType: "image/svg+xml", previewUrl: "/vector.svg" }),
      attachment("photo", { name: "photo.heic", mimeType: "image/heic", previewUrl: "/photo.heic" }),
    ];
    await act(async () => root.render(<ChatAttachments items={items} role="assistant" onOpen={() => {}} />));

    expect(container.querySelectorAll(".chat-image-grid img")).toHaveLength(0);
    expect([...container.querySelectorAll("[data-chat-attachment-index]")].map(node => node.textContent))
      .toEqual(expect.arrayContaining([expect.stringContaining("vector.svg"), expect.stringContaining("photo.heic")]));
    expect(container.querySelector(".chat-image-grid")).toBeNull();
  });

  it("deduplicates repeated item IDs and preserves the first display position", async () => {
    const first = attachment("same", {
      mimeType: "application/zip",
      previewKind: "info",
      previewUrl: null,
      name: "first-name.zip",
    });
    const duplicate = { ...first, name: "second-name.zip" };
    await act(async () => root.render(<ChatAttachments items={[first, duplicate]} role="assistant" onOpen={() => {}} />));

    expect(container.querySelectorAll('[data-chat-attachment-key="same"]')).toHaveLength(1);
    expect(container.querySelector('[data-chat-attachment-index="0"]')?.textContent).toContain("first-name.zip");
    expect(container.querySelector('[data-chat-attachment-index="1"]')).toBeNull();
  });

  it("keeps missing and unavailable rows in relative order with full-item modal indexes", async () => {
    const items = [
      attachment("first"),
      attachment("missing", { availability: "missing", previewUrl: null, originalUrl: null }),
      attachment("notes", { name: "notes.txt", mimeType: "text/plain", previewKind: "text" }),
      attachment("second"),
      attachment("unavailable", {
        name: null,
        mimeType: null,
        byteSize: null,
        previewKind: "info",
        availability: "unavailable",
        previewUrl: null,
        originalUrl: null,
        source: { kind: "unavailable", attachmentId: "unavailable", context: sessionContext },
      }),
    ];
    const onOpen = vi.fn();
    await act(async () => root.render(<ChatAttachments items={items} role="assistant" onOpen={onOpen} />));

    const rows = [...container.querySelectorAll<HTMLButtonElement>("[data-chat-attachment-index]")];
    expect(rows.map(row => row.getAttribute("data-chat-attachment-key")))
      .toEqual(["missing", "notes", "unavailable"]);
    expect(rows.map(row => row.getAttribute("data-chat-attachment-index"))).toEqual(["1", "2", "4"]);
    expect(rows[0].textContent).toContain("원본을 찾을 수 없습니다");
    expect(rows[2].textContent).toContain("현재 사용할 수 없습니다");
    expect(rows[2].textContent).not.toContain("0 B");
    expect(container.querySelectorAll("[data-chat-image-index], [data-chat-attachment-index]")).toHaveLength(items.length);
    for (const index of [0, 2]) {
      await act(async () => rows[index].click());
      expect(onOpen).toHaveBeenLastCalledWith(index === 0 ? 1 : 4, rows[index]);
    }
  });

  it("preserves a long Korean filename and scopes a failed image to its own thumbnail", async () => {
    const longName = "회의자료_아주긴한국어파일이름_최종검토본.png";
    const row = attachment("long-name", {
      name: longName,
      mimeType: "application/zip",
      previewKind: "info",
      previewUrl: null,
    });
    const images = [attachment("failed"), attachment("clickable")];
    const onOpen = vi.fn();
    await act(async () => root.render(<ChatAttachments items={[row, ...images]} role="assistant" onOpen={onOpen} />));

    const name = container.querySelector<HTMLElement>(".chat-attachment-name");
    expect(name?.title).toBe(longName);
    expect(name?.classList.contains("chat-image-filename")).toBe(true);
    expect(name?.textContent).toBe(longName);
    const failedImage = container.querySelector<HTMLImageElement>('[data-chat-image-index="1"] img')!;
    await act(async () => failedImage.dispatchEvent(new Event("error")));
    expect(container.querySelector('[data-chat-image-index="1"] [role="status"]')?.textContent)
      .toContain("불러오지 못했습니다");
    expect(container.querySelector('[data-chat-attachment-index="1"]')).toBeNull();
    const failedCard = container.querySelector('[data-chat-image-index="1"]')!;
    expect(failedCard.textContent).toContain("failed.png");
    expect(failedCard.textContent).toContain("image/png");
    expect(failedCard.textContent).toContain("1.0 KB");
    const failedButton = failedCard.querySelector<HTMLButtonElement>("button")!;
    expect(failedButton).not.toBeNull();
    expect(failedButton?.getAttribute("aria-label")).toContain("failed.png");
    await act(async () => failedButton.click());
    expect(onOpen).toHaveBeenCalledWith(1, failedButton);
    expect(container.querySelectorAll("[data-chat-image-index], [data-chat-attachment-index]")).toHaveLength(3);

    const clickableImage = container.querySelector<HTMLImageElement>('[data-chat-image-index="2"] img[role="button"]')!;
    expect(clickableImage).toBeDefined();
    await act(async () => clickableImage.click());
    expect(onOpen).toHaveBeenCalledWith(2, clickableImage);
  });

  it("keeps the default local tile and separates chip viewing from removal", async () => {
    const file = new File(["draft"], "draft.txt", { type: "text/plain" });
    const markup = renderToStaticMarkup(createElement(FileAttachmentPreview, {
      file,
      status: "done",
      onRemove: () => {},
    }));
    expect(markup).toContain("relative shrink-0 w-20 h-20 rounded border border-border bg-muted overflow-hidden");

    const onOpen = vi.fn();
    const onRemove = vi.fn();
    await act(async () => root.render(
      <FileAttachmentPreview variant="chip" file={file} status="done" onOpen={onOpen} onRemove={onRemove} />,
    ));
    const view = container.querySelector<HTMLButtonElement>("[data-chat-attachment-chip-view]")!;
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove file"]')!;
    await act(async () => view.click());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(file, view);
    await act(async () => remove.click());
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
