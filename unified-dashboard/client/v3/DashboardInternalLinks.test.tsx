/** @vitest-environment jsdom */
import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InternalLinkTarget } from "@seosoyoung/soul-ui";
import { DashboardInternalLinks, useDashboardInternalLinks, useRegisterDashboardLinkOpeners, type DashboardLinkOpeners } from "./DashboardInternalLinks";
import { useInternalLinkClick } from "@seosoyoung/soul-ui";
import { MarkdownContent } from "@seosoyoung/soul-ui/components/MarkdownContent";
import { InternalLinkViewers } from "./InternalLinkViewers";

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  fetchDocument: vi.fn(),
  navigate: vi.fn(),
  refreshAuthStatus: vi.fn(async () => {}),
}));

vi.mock("@seosoyoung/soul-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seosoyoung/soul-ui")>();
  return {
    ...actual,
    useAuth: () => ({ refreshAuthStatus: mocks.refreshAuthStatus }),
  };
});
vi.mock("./use-v3-notifications", () => ({
  useV3Notifications: () => ({ toast: null, notify: mocks.notify, notifyWriteFailure: vi.fn() }),
}));
vi.mock("../dashboard-navigation", () => ({
  navigateDashboard: (...args: unknown[]) => mocks.navigate(...args),
}));
vi.mock("@seosoyoung/soul-ui/lib/markdown-document-operations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seosoyoung/soul-ui/lib/markdown-document-operations")>();
  return {
    ...actual,
    fetchMarkdownDocument: mocks.fetchDocument,
    updateMarkdownDocument: vi.fn(),
    deleteMarkdownDocument: vi.fn(),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Link({ href }: { href: string }) {
  const onClick = useInternalLinkClick();
  return <a href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>open</a>;
}

function LinkState() {
  const { selectedDocumentId, selectedImage } = useDashboardInternalLinks();
  return <div data-testid="link-state" data-document={selectedDocumentId ?? ""} data-image={selectedImage?.src ?? ""}/>;
}

function Register({ openers }: { openers: DashboardLinkOpeners }) {
  useRegisterDashboardLinkOpeners(openers);
  return null;
}

function RegisterViewers() {
  const { openDocument, openImage } = useDashboardInternalLinks();
  const openers = useMemo<DashboardLinkOpeners>(() => ({
    document: (target: InternalLinkTarget) => target.kind === "document" ? openDocument(target.documentId) : false,
    attachment: (target: InternalLinkTarget, href: string) => target.kind === "attachment" && target.isImage
      ? openImage(href)
      : false,
  }), [openDocument, openImage]);
  return <Register openers={openers}/>;
}

describe("DashboardInternalLinks", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  async function render(href: string, registerViewers = false, customOpeners?: DashboardLinkOpeners) {
    host = document.createElement("div");
    host.className = "v3-shell";
    const rootHost = document.createElement("div");
    host.appendChild(rootHost);
    document.body.appendChild(host);
    root = createRoot(rootHost);
    await act(async () => root!.render(
      <DashboardInternalLinks>
        {registerViewers ? <RegisterViewers/> : null}
        {customOpeners ? <Register openers={customOpeners}/> : null}
        <Link href={href}/>
        <LinkState/>
      </DashboardInternalLinks>,
    ));
    return host.querySelector("a")!;
  }

  async function click(anchor: HTMLAnchorElement) {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      anchor.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return event;
  }

  it("dispatches registered target kinds and falls back to the shared internal path", async () => {
    const cardOpener = vi.fn(() => true);
    const openers = { card: cardOpener };
    const anchor = await render("/?card=card-1", false, openers);
    await click(host!.querySelector("a")!);
    expect(cardOpener).toHaveBeenCalledWith({ kind: "card", cardId: "card-1" }, "/?card=card-1", "open");
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(anchor.getAttribute("href")).toBe("/?card=card-1");

    act(() => root!.unmount());
    root = undefined;
    host?.remove();
    host = undefined;
    await render("/?folder=folder-1");
    await click(host!.querySelector("a")!);
    expect(mocks.navigate).toHaveBeenCalledWith("/?folder=folder-1");
  });

  it("selects a document immediately without querying it", async () => {
    await render("/api/markdown-documents/doc-1", true);
    await click(host!.querySelector("a")!);
    expect(host!.querySelector("[data-testid=link-state]")?.getAttribute("data-document")).toBe("doc-1");

    expect(mocks.fetchDocument).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("closes the document before opening another screen", async () => {
    const cardOpener = vi.fn(() => true);
    const anchor = await render("/?document=doc-1", true, { card: cardOpener });
    await click(anchor);
    anchor.href = "/?card=card-1";
    await click(anchor);
    expect(host!.querySelector("[data-testid=link-state]")?.getAttribute("data-document")).toBe("");
    expect(cardOpener).toHaveBeenCalled();
  });

  it("opens an image only after load and reports an image error", async () => {
    class LoadedImage {
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.(new Event("load")));
      }
    }
    vi.stubGlobal("Image", LoadedImage);
    await render("/api/attachments/files?nodeId=node-1&path=%2Fcapture.png", true);
    await click(host!.querySelector("a")!);
    expect(host!.querySelector("[data-testid=link-state]")?.getAttribute("data-image"))
      .toBe("/api/attachments/files?nodeId=node-1&path=%2Fcapture.png");

    class FailedImage extends LoadedImage {
      override set src(_value: string) {
        queueMicrotask(() => this.onerror?.(new Event("error")));
      }
    }
    vi.stubGlobal("Image", FailedImage);
    act(() => root!.unmount());
    root = undefined;
    await render("/api/attachments/files?nodeId=node-1&path=%2Fmissing.png", true);
    await click(host!.querySelector("a")!);
    expect(host!.querySelector("[data-testid=link-state]")?.getAttribute("data-image")).toBe("");
    expect(mocks.notify).toHaveBeenCalledWith("이미지를 불러오지 못했습니다.");
  });

  it("opens a rendered Markdown attachment link in the shared viewer", async () => {
    const markdown = "# Attachment popup\n\nThis came from the attachment.";
    const bytes = new TextEncoder().encode(markdown);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "/api/attachments/attachment-markdown?context_type=session&context_id=session-1") {
        return Response.json({
          descriptor: {
            attachment_id: "attachment-markdown",
            name: "report.md",
            mime_type: "text/markdown",
            byte_size: bytes.byteLength,
            checksum_sha256: null,
            width: null,
            height: null,
            preview_kind: "text",
            preview_mime_type: "text/markdown",
          },
          upload_status: "committed",
        });
      }
      if (url.startsWith("/api/attachments/attachment-markdown/content")) {
        expect((init?.headers as Record<string, string> | undefined)?.Range).toBe(`bytes=0-${bytes.byteLength - 1}`);
        return new Response(markdown, {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
            "Content-Length": String(bytes.byteLength),
            "Content-Type": "text/markdown",
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    host = document.createElement("div");
    const rootHost = document.createElement("div");
    host.appendChild(rootHost);
    document.body.appendChild(host);
    root = createRoot(rootHost);
    await act(async () => root!.render(
      <DashboardInternalLinks>
        <InternalLinkViewers />
        <MarkdownContent content="[보고서](/api/attachments/attachment-markdown/content?context_type=session&context_id=session-1)" />
      </DashboardInternalLinks>,
    ));

    const anchor = host.querySelector<HTMLAnchorElement>("a")!;
    const event = await click(anchor);

    expect(event.defaultPrevented).toBe(true);
    // React flushes updates when each act() scope ends, so wait between short act() ticks.
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.body.querySelector(".chat-attachment-markdown h1")?.textContent).toBe("Attachment popup");
    });
    expect(document.body.querySelector(".chat-image-viewer-title")?.textContent).toBe("report.md");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/attachments/attachment-markdown?context_type=session&context_id=session-1",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("uses the link label as the viewer title when attachment metadata returns 404", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    host = document.createElement("div");
    host.className = "v3-shell";
    const rootHost = document.createElement("div");
    host.appendChild(rootHost);
    document.body.appendChild(host);
    root = createRoot(rootHost);
    await act(async () => root!.render(
      <DashboardInternalLinks>
        <InternalLinkViewers />
        <MarkdownContent content="[보고서](/api/attachments/attachment-missing/content?context_type=session&context_id=session-1)" />
      </DashboardInternalLinks>,
    ));

    const anchor = host.querySelector<HTMLAnchorElement>("a")!;
    const event = await click(anchor);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.body.querySelector(".chat-image-viewer-title")?.textContent).toBe("보고서");
      expect(document.body.textContent).toContain("첨부를 찾을 수 없습니다.");
    });
  });
});
