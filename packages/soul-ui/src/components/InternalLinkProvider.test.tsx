/**
 * @vitest-environment jsdom
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InternalLinkProvider, useInternalLinkClick } from "./InternalLinkProvider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ClickOptions = Pick<MouseEventInit, "button" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

function TestLink({ href, onParentClick }: { href: string; onParentClick: () => void }) {
  const onClick = useInternalLinkClick();
  return (
    <div onClick={onParentClick}>
      <a href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>
        Open
      </a>
    </div>
  );
}

describe("useInternalLinkClick", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  async function renderLink(options: {
    href: string;
    openTarget?: (target: unknown, href: string) => void;
    withProvider?: boolean;
  }) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const onParentClick = vi.fn();
    const link = <TestLink href={options.href} onParentClick={onParentClick} />;
    await act(async () => root!.render(options.withProvider
      ? <InternalLinkProvider internalOrigins={["https://soulstream.eiaserinnys.me"]} openTarget={options.openTarget ?? vi.fn()}>
          {link}
        </InternalLinkProvider>
      : link));
    return { anchor: host.querySelector("a")!, onParentClick };
  }

  function click(anchor: HTMLAnchorElement, options: ClickOptions = {}) {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options });
    anchor.dispatchEvent(event);
    return event;
  }

  it.each([
    ["session", "https://soulstream.eiaserinnys.me/?session=session-1&event=7", { kind: "session", sessionId: "session-1", eventId: "7" }],
    ["card", "/?card=card-1", { kind: "card", cardId: "card-1" }],
    ["document", "/api/markdown-documents/doc-1", { kind: "document", documentId: "doc-1" }],
    ["folder", "/?folder=folder-1", { kind: "folder", folderId: "folder-1" }],
    ["page", "/?page=page-1", { kind: "page", pageId: "page-1" }],
    ["image attachment", "/api/attachments/files?nodeId=node-1&path=%2Fimage.png", { kind: "attachment", nodeId: "node-1", path: "/image.png", isImage: true }],
  ])("handles an ordinary %s click without changing the anchor", async (_name, href, target) => {
    const openTarget = vi.fn();
    const { anchor, onParentClick } = await renderLink({ href, openTarget, withProvider: true });
    const event = click(anchor);

    expect(event.defaultPrevented).toBe(true);
    expect(openTarget).toHaveBeenCalledWith(target, href);
    expect(onParentClick).not.toHaveBeenCalled();
    expect(anchor.getAttribute("href")).toBe(href);
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it.each([
    ["provider missing", "https://soulstream.eiaserinnys.me/?card=card-1", false, {}],
    ["external address", "https://example.com/?card=card-1", true, {}],
    ["unclassified route", "/api/custom-views/view-1", true, {}],
    ["non-image attachment", "/api/attachments/files?nodeId=node-1&path=%2Freport.pdf", true, {}],
    ["Ctrl click", "/?card=card-1", true, { ctrlKey: true }],
    ["Command click", "/?card=card-1", true, { metaKey: true }],
    ["Shift click", "/?card=card-1", true, { shiftKey: true }],
    ["Alt click", "/?card=card-1", true, { altKey: true }],
    ["middle click", "/?card=card-1", true, { button: 1 }],
  ])("keeps browser navigation for %s", async (_name, href, withProvider, options) => {
    const openTarget = vi.fn();
    const { anchor, onParentClick } = await renderLink({ href, withProvider, openTarget });
    const event = click(anchor, options);

    expect(event.defaultPrevented).toBe(false);
    expect(openTarget).not.toHaveBeenCalled();
    expect(onParentClick).toHaveBeenCalledTimes(1);
  });

  it("leaves an already-prevented click to its existing handler", async () => {
    const openTarget = vi.fn();
    const { anchor, onParentClick } = await renderLink({ href: "/?card=card-1", withProvider: true, openTarget });
    anchor.addEventListener("click", (event) => event.preventDefault(), { capture: true, once: true });
    const event = click(anchor);

    expect(event.defaultPrevented).toBe(true);
    expect(openTarget).not.toHaveBeenCalled();
    expect(onParentClick).toHaveBeenCalledTimes(1);
  });
});
