/** @vitest-environment jsdom */
import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InternalLinkTarget } from "@seosoyoung/soul-ui";
import { DashboardInternalLinks, useDashboardInternalLinks, useRegisterDashboardLinkOpeners, type DashboardLinkOpeners } from "./DashboardInternalLinks";
import { useInternalLinkClick } from "@seosoyoung/soul-ui";

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
  const { selectedDocument, selectedImage } = useDashboardInternalLinks();
  return <div data-testid="link-state" data-document={selectedDocument?.id ?? ""} data-image={selectedImage?.src ?? ""}/>;
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
    expect(cardOpener).toHaveBeenCalledWith({ kind: "card", cardId: "card-1" }, "/?card=card-1");
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

  it("opens a fetched document and reports a fetch failure without selecting it", async () => {
    mocks.fetchDocument.mockResolvedValueOnce({ id: "doc-1", title: "문서", body: "본문", version: 1 });
    await render("/api/markdown-documents/doc-1", true);
    await click(host!.querySelector("a")!);
    expect(host!.querySelector("[data-testid=link-state]")?.getAttribute("data-document")).toBe("doc-1");

    act(() => root!.unmount());
    root = undefined;
    mocks.fetchDocument.mockRejectedValueOnce(new Error("마크다운 문서를 불러오지 못했습니다 (404)"));
    await render("/api/markdown-documents/missing", true);
    await click(host!.querySelector("a")!);
    expect(host!.querySelector("[data-testid=link-state]")?.getAttribute("data-document")).toBe("");
    expect(mocks.notify).toHaveBeenCalledWith("마크다운 문서를 불러오지 못했습니다 (404)");
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
});
