/**
 * @vitest-environment jsdom
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InternalLinkProvider } from "./InternalLinkProvider";
import { SourceLink } from "./SourceLink";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SourceLink", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  it("keeps the source href and Button focus ring on the link text", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(
      <SourceLink href="https://example.com/reference" node={{ type: "element" }}>원문</SourceLink>,
    ));

    const anchor = host.querySelector("a")!;
    expect(anchor.getAttribute("href")).toBe("https://example.com/reference");
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor.hasAttribute("node")).toBe(false);
    expect(anchor.className).toContain("inline-block");
    expect(anchor.className).toContain("w-fit");
    expect(anchor.className).toContain("max-w-full");
    expect(anchor.className).toContain("outline-none");
    expect(anchor.className).toContain("focus-visible:ring-2");
    expect(anchor.className).toContain("focus-visible:ring-offset-1");
    expect(anchor.classList.contains("w-full")).toBe(false);
  });

  it("routes internal source clicks through useInternalLinkClick", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const openTarget = vi.fn();
    const onParentClick = vi.fn();
    await act(async () => root!.render(
      <InternalLinkProvider
        internalOrigins={["https://soulstream.eiaserinnys.me"]}
        openTarget={openTarget}
      >
        <div onClick={onParentClick}>
          <SourceLink href="https://soulstream.eiaserinnys.me/?card=card-1">카드</SourceLink>
        </div>
      </InternalLinkProvider>,
    ));

    const anchor = host.querySelector("a")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(openTarget).toHaveBeenCalledWith({ kind: "card", cardId: "card-1" }, anchor.href, "카드");
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
