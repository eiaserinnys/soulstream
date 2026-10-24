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

function remoteMedia(name: string, mimeType: string, byteSize = 12): ChatAttachmentItem {
  const attachmentId = name;
  const context = { type: "session" as const, id: "sample" };
  return attachment({
    key: `asset:${name}`,
    name,
    mimeType,
    byteSize,
    previewKind: "info",
    previewUrl: null,
    originalUrl: `/api/attachments/${encodeURIComponent(attachmentId)}/content?context_type=session&context_id=sample&download=true`,
    source: { kind: "asset", attachmentId, context },
  });
}

function localMedia(file: File): ChatAttachmentItem {
  return attachment({
    key: `local:${file.name}`,
    name: file.name,
    mimeType: file.type,
    byteSize: file.size,
    previewKind: "info",
    previewUrl: null,
    originalUrl: null,
    source: { kind: "local", file },
  });
}

function stubObjectUrls() {
  const createObjectURL = vi.fn(() => "blob:sample-media");
  const revokeObjectURL = vi.fn();
  class URLWithObjectUrls extends globalThis.URL {}
  Object.assign(URLWithObjectUrls, { createObjectURL, revokeObjectURL });
  vi.stubGlobal("URL", URLWithObjectUrls);
  return { createObjectURL, revokeObjectURL };
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

  it("keeps plain text as a React text child and keeps original save available", async () => {
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

  it("renders markdown through the shared document renderer", async () => {
    const markdown = [
      "# 톤 제안",
      "",
      "## 요약",
      "",
      "- 첫 번째",
      "- 두 번째",
      "",
      "| 항목 | 값 |",
      "| --- | --- |",
      "| 상태 | 준비 |",
      "",
      "    const value = 1;",
      "",
      "[참고 링크](https://example.com)",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => rangeResponse(markdown)));
    await act(async () => root.render(<ViewerHarness items={[attachment({
      name: "톤 제안 원문.md",
      mimeType: "text/markdown",
      byteSize: new TextEncoder().encode(markdown).byteLength,
    })]} />));

    const dialog = document.body.querySelector("[role=dialog]");
    expect(dialog?.querySelector("h1")?.textContent).toBe("톤 제안");
    expect(dialog?.querySelector(".chat-attachment-markdown h1")?.textContent).toBe("톤 제안");
    expect(dialog?.querySelector(".chat-image-viewer-panel h2")?.textContent).toBe("요약");
    expect(dialog?.querySelector("ul li")?.textContent).toBe("첫 번째");
    expect(dialog?.querySelector("table td")?.textContent).toBe("상태");
    expect(dialog?.querySelector("pre code")?.textContent).toContain("const value = 1;");
    expect(dialog?.querySelector('a[href="https://example.com"]')?.textContent).toBe("참고 링크");
  });

  it("renders HTML in a script-only sandboxed iframe", async () => {
    const html = "<!doctype html><html><body><button>열기</button></body></html>";
    vi.stubGlobal("fetch", vi.fn(async () => rangeResponse(html)));
    await act(async () => root.render(<ViewerHarness items={[attachment({
      name: "보고서 시안.html",
      mimeType: "text/html",
      byteSize: new TextEncoder().encode(html).byteLength,
    })]} />));

    const dialog = document.body.querySelector("[role=dialog]");
    const frame = dialog?.querySelector<HTMLIFrameElement>("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.title).toBe("보고서 시안.html");
    expect(dialog?.querySelector("pre")).toBeNull();
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

  it("renders remote video and audio from info-kind attachments", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const videoItem = remoteMedia("clip.mp4", "video/mp4");
    await act(async () => root.render(<ViewerHarness items={[videoItem]} />));

    const video = document.body.querySelector<HTMLVideoElement>("video.chat-attachment-video-player");
    expect(video?.getAttribute("src")).toBe("/api/attachments/clip.mp4/content?context_type=session&context_id=sample");
    expect(video?.controls).toBe(true);
    expect(video?.playsInline).toBe(true);
    expect(document.body.querySelector(".chat-attachment-media-frame")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["sample-audio.mp3", "audio/mpeg"],
    ["sample-audio.wav", "audio/wav"],
    ["sample-audio.flac", "audio/flac"],
  ])("renders remote audio %s from an info-kind attachment", async (name, mimeType) => {
    await act(async () => root.render(<ViewerHarness items={[remoteMedia(name, mimeType)]} />));

    const audio = document.body.querySelector<HTMLAudioElement>("audio.chat-attachment-audio-player");
    expect(audio?.getAttribute("src")).toBe(`/api/attachments/${encodeURIComponent(name)}/content?context_type=session&context_id=sample`);
    expect(audio?.controls).toBe(true);
    expect(audio?.preload).toBe("metadata");
  });

  it.each([
    ["sample-video.mp4", "video/mp4", "video"],
    ["sample-audio.mp3", "audio/mpeg", "audio"],
    ["sample-audio.wav", "audio/wav", "audio"],
    ["sample-audio.flac", "audio/flac", "audio"],
  ] as const)("creates and revokes a local %s media URL", async (name, mimeType, format) => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrls();
    const file = new File(["sample media"], name, { type: mimeType });
    await act(async () => root.render(<ViewerHarness items={[localMedia(file)]} />));

    const player = document.body.querySelector<HTMLMediaElement>(`${format}.chat-attachment-${format}-player`);
    expect(player?.getAttribute("src")).toBe("blob:sample-media");
    expect(createObjectURL).toHaveBeenCalledWith(file);

    await act(async () => root.render(null));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:sample-media");
  });

  it("shows empty media files without requesting or opening them", async () => {
    const fetchMock = vi.fn();
    const { createObjectURL } = stubObjectUrls();
    vi.stubGlobal("fetch", fetchMock);
    const emptyLocal = new File([], "empty.mp3", { type: "audio/mpeg" });
    await act(async () => root.render(<ViewerHarness items={[
      remoteMedia("empty.mp4", "video/mp4", 0),
      localMedia(emptyLocal),
    ]} />));

    const status = document.body.querySelector('[role="status"].chat-attachment-state.chat-image-status');
    expect(status?.textContent).toBe("빈 파일");
    expect(document.body.querySelector("video, audio")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();

    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="다음 첨부"]')!.click());
    expect(document.body.querySelector('[role="status"].chat-attachment-state.chat-image-status')?.textContent).toBe("빈 파일");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    [401, "첨부를 읽을 수 없습니다.", false],
    [403, "첨부를 읽을 수 없습니다.", false],
    [404, "첨부를 찾을 수 없습니다.", false],
    [503, "첨부를 불러오지 못했습니다.", true],
    [200, "미리보기를 불러오지 못했습니다.", false],
    ["network", "첨부를 불러오지 못했습니다.", true],
  ] as const)("maps remote media load failure %s", async (failure, message, retryable) => {
    const fetchMock = vi.fn(async () => {
      if (failure === "network") throw new TypeError("Failed to fetch");
      return new Response(null, { status: failure });
    });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<ViewerHarness items={[remoteMedia("clip.mp4", "video/mp4")]} />));
    const player = document.body.querySelector("video")!;
    await act(async () => player.dispatchEvent(new Event("error")));

    const dialog = document.body.querySelector('[role="dialog"]')!;
    await vi.waitFor(() => expect(dialog.querySelector('[role="status"]')?.textContent).toContain(message));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/attachments/clip.mp4/content?context_type=session&context_id=sample",
      expect.objectContaining({ method: "HEAD", credentials: "same-origin" }),
    );
    expect(dialog.textContent?.includes("다시 시도")).toBe(retryable);
  });

  it("retries failed remote media and clears the failure on loaded data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await act(async () => root.render(<ViewerHarness items={[remoteMedia("clip.mp4", "video/mp4")]} />));
    const firstPlayer = document.body.querySelector("video")!;
    await act(async () => firstPlayer.dispatchEvent(new Event("error")));
    const retry = await vi.waitFor(() => {
      const button = [...document.body.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("다시 시도"));
      expect(button).toBeDefined();
      return button!;
    });

    await act(async () => retry.click());
    const nextPlayer = document.body.querySelector("video")!;
    expect(nextPlayer).not.toBe(firstPlayer);
    expect(document.body.querySelector(".chat-attachment-state")).toBeNull();
    await act(async () => nextPlayer.dispatchEvent(new Event("loadeddata")));
    expect(document.body.querySelector(".chat-attachment-state")).toBeNull();
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
