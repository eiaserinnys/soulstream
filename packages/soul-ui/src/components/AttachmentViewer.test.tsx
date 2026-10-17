/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentViewer } from "./AttachmentViewer";
import type { ChatAttachmentItem } from "../lib/chat-attachment-model";

function attachment(overrides: Partial<ChatAttachmentItem> = {}): ChatAttachmentItem {
  return {
    key: "asset:one",
    name: "one.txt",
    mimeType: "text/plain",
    byteSize: 0,
    previewKind: "text",
    availability: "ready",
    previewUrl: "/api/attachments/one/content?context_type=session&context_id=sample",
    originalUrl: "/api/attachments/one/content?context_type=session&context_id=sample&download=true",
    legacySources: [],
    source: { kind: "asset", attachmentId: "one", context: { type: "session", id: "sample" } },
    ...overrides,
  };
}

function ViewerHarness({ items, initialIndex = 0 }: { items: ChatAttachmentItem[]; initialIndex?: number | null }) {
  const [index, setIndex] = useState<number | null>(initialIndex);
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null);
  return (
    <>
      <button ref={setReturnFocus} type="button" onClick={() => setIndex(0)}>첨부 열기</button>
      <AttachmentViewer
        items={items}
        index={index}
        onIndexChange={setIndex}
        onClose={() => setIndex(null)}
        returnFocus={returnFocus}
      />
    </>
  );
}

function rangeResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(bytes, {
    status: 206,
    headers: {
      "Content-Range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
      "Content-Length": String(bytes.byteLength),
    },
  });
}

describe("AttachmentViewer", () => {
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

  it("uses the existing image viewer frame and hides navigation for one item", async () => {
    const image = attachment({
      key: "image:one",
      name: "one.png",
      mimeType: "image/png",
      previewKind: "image",
      previewUrl: "/one.png",
      originalUrl: null,
      source: { kind: "markdown-image", src: "/one.png", alt: "한 장" },
    });
    await act(async () => root.render(<ViewerHarness items={[image]} />));

    const popup = document.body.querySelector(".chat-image-viewer-popup");
    expect(popup).not.toBeNull();
    expect(popup?.querySelector(".chat-image-viewer-panel")).not.toBeNull();
    expect(popup?.querySelector(".chat-image-viewer-image")).not.toBeNull();
    expect(popup?.querySelector(".chat-image-viewer-footer")).toBeNull();
    expect(popup?.textContent).toContain("one.png");
  });

  it("shows fetched text as a React text child and keeps original save available", async () => {
    const unsafeText = "<script>window.pwned = true</script>\n**literal markdown**";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null, { status: 200 }) : rangeResponse(unsafeText),
    );
    vi.stubGlobal("fetch", fetchMock);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await act(async () => root.render(<ViewerHarness items={[attachment({ byteSize: new TextEncoder().encode(unsafeText).byteLength })]} />));

    const dialog = document.body.querySelector("[role=dialog]");
    const pre = dialog?.querySelector("pre");
    expect(pre?.textContent).toBe(unsafeText);
    expect(pre?.querySelector("script, strong, em, code")).toBeNull();
    const save = [...(dialog?.querySelectorAll("button") ?? [])].find(button => button.textContent?.includes("저장"));
    expect(save).toBeDefined();
    await act(async () => save?.click());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("download=true"),
      expect.objectContaining({ method: "HEAD" }),
    );
    expect(anchorClick).toHaveBeenCalledOnce();
  });

  it("keeps missing info separate from previews and hides unavailable original save", async () => {
    const info = attachment({
      name: "archive.svg",
      mimeType: "image/svg+xml",
      previewKind: "info",
      availability: "missing",
      previewUrl: null,
      originalUrl: null,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<ViewerHarness items={[info]} />));

    const dialog = document.body.querySelector("[role=dialog]");
    expect(dialog?.textContent).toContain("archive.svg");
    expect(dialog?.textContent).not.toContain("image/svg+xml");
    expect(dialog?.textContent).toContain("찾을 수 없습니다");
    expect(dialog?.querySelector("pre, img")).toBeNull();
    const save = [...((dialog?.querySelectorAll("button")) ?? [])].find(button => button.textContent?.includes("원본 저장"));
    expect(save).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("moves between mixed items without cycling and handles arrow keys", async () => {
    const items = [
      attachment({ key: "first", name: "first.txt", byteSize: 0 }),
      attachment({ key: "second", name: "second.svg", mimeType: "image/svg+xml", previewKind: "info", previewUrl: null, originalUrl: null }),
      attachment({ key: "third", name: "third.txt", byteSize: 0 }),
    ];
    await act(async () => root.render(<ViewerHarness items={items} initialIndex={0} />));

    const dialog = document.body.querySelector("[role=dialog]")!;
    const previous = dialog.querySelector<HTMLButtonElement>('[aria-label="이전 첨부"]')!;
    const next = dialog.querySelector<HTMLButtonElement>('[aria-label="다음 첨부"]')!;
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    expect(previous.disabled).toBe(false);
    expect(dialog.textContent).toContain("1/3");
    await act(async () => next.click());
    expect(document.body.querySelector("[role=dialog]")?.textContent).toContain("second.svg");
    await act(async () => document.body.querySelector("[role=dialog]")?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.body.querySelector("[role=dialog]")?.textContent).toContain("3/3");
    const lastNext = document.body.querySelector<HTMLButtonElement>('[aria-label="다음 첨부"]')!;
    expect(lastNext.getAttribute("aria-disabled")).toBe("true");
    expect(lastNext.disabled).toBe(false);
    await act(async () => document.body.querySelector("[role=dialog]")?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.body.querySelector("[role=dialog]")?.textContent).toContain("3/3");
  });

  it("aborts the previous text request when the selected item changes", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 200 }));
      return new Promise<Response>(resolve => { resolveFetch = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const items = [
      attachment({ key: "first", name: "first.txt", byteSize: 1 }),
      attachment({ key: "second", name: "second.txt", byteSize: 0 }),
    ];
    await act(async () => root.render(<ViewerHarness items={items} />));
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="다음 첨부"]')?.click());
    expect(signal?.aborted).toBe(true);
    resolveFetch(rangeResponse("x"));
  });

  it("retries a failed text preview and returns focus to the trigger on Escape", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(rangeResponse("다시 읽음"));
    vi.stubGlobal("fetch", fetchMock);
    const item = attachment({ byteSize: new TextEncoder().encode("다시 읽음").byteLength });
    await act(async () => root.render(<ViewerHarness items={[item]} initialIndex={null} />));
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => trigger.click());
    expect(document.body.textContent).toContain("첨부를 불러오지 못했습니다");
    const retry = [...document.body.querySelectorAll("button")].find(button => button.textContent?.includes("다시 시도"));
    await act(async () => retry?.click());
    expect(document.body.textContent).toContain("다시 읽음");
    await act(async () => document.body.querySelector("[role=dialog]")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it.each([403, 404])("does not offer retry for text HTTP %s", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
    await act(async () => root.render(<ViewerHarness items={[attachment({ byteSize: 1 })]} />));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).not.toContain("다시 시도");
    expect(dialog.querySelector('.chat-attachment-state')).not.toBeNull();
  });

  it.each([403, 404, 503, "network"] as const)("offers image retry only for recoverable failure %s", async failure => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (failure === "network") throw new TypeError("Failed to fetch");
      return new Response(null, { status: failure });
    }));
    await act(async () => root.render(<ViewerHarness items={[
      attachment({ name: "photo.png", previewKind: "image", previewUrl: "/photo.png" }),
    ]} />));
    await act(async () => document.body.querySelector("img")!.dispatchEvent(new Event("error")));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("이미지를 불러오지 못했습니다.");
    expect(dialog.textContent?.includes("다시 시도")).toBe(failure === 503 || failure === "network");
  });

  it("shows empty text and an extension icon for info without extra prose", async () => {
    await act(async () => root.render(<ViewerHarness items={[
      attachment(), attachment({ key: "svg", name: "vector.svg", mimeType: "image/svg+xml", previewKind: "info", previewUrl: null }),
    ]} />));
    expect(document.body.querySelector('.chat-attachment-state')?.textContent).toBe("빈 파일");
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="다음 첨부"]')!.click());
    expect(document.body.querySelector('.chat-attachment-state')?.textContent).toBe("SVG");
  });

  it("uses size-only shared metadata and keeps focus inside at both navigation ends", async () => {
    const items = [
      attachment({ key: "first", previewKind: "info", byteSize: 1_048_576, name: "first.zip" }),
      attachment({ key: "missing", availability: "missing", originalUrl: null, previewUrl: null }),
    ];
    await act(async () => root.render(<ViewerHarness items={items} initialIndex={null} />));
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    // Base UI moves initial focus into the dialog asynchronously; wait for it instead of racing it.
    await vi.waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(dialog.querySelector('.chat-image-viewer-metadata')?.textContent).toBe("1.0 MB");
    const next = dialog.querySelector<HTMLButtonElement>('[aria-label="다음 첨부"]')!;
    next.focus();
    await act(async () => next.click());
    expect(document.activeElement).toBe(next);
    expect(next.disabled).toBe(false);
    expect(next.getAttribute('aria-disabled')).toBe('true');
    await act(async () => next.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(dialog.textContent).toContain('1/2');
  });
});
