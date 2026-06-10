/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionContextMenu } from "./SessionContextMenu";

function renderMenu(props: Partial<React.ComponentProps<typeof SessionContextMenu>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClose = vi.fn();

  flushSync(() => {
    root.render(
      createElement(SessionContextMenu, {
        contextMenu: { x: 10, y: 20, sessionId: "session-a" },
        onClose,
        getSessionName: () => "Session A",
        resolveSessionIds: (sessionId: string) => [sessionId],
        ...props,
      }),
    );
  });

  return { container, root, onClose };
}

function findMenuItem(text: string): HTMLElement {
  const item = Array.from(document.body.querySelectorAll<HTMLElement>("[data-slot='menu-item'], button"))
    .find((element) => element.textContent?.trim() === text);
  if (!item) throw new Error(`Menu item not found: ${text}`);
  return item;
}

describe("SessionContextMenu", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    container?.remove();
    document.body.innerHTML = "";
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
  });

  it("shows continue-session action and calls the injected callback", async () => {
    const onContinueSession = vi.fn().mockResolvedValue(undefined);
    ({ container, root } = renderMenu({
      onContinueSession,
      getContinueSessionDisabledReason: () => null,
    }));

    const item = findMenuItem("이 세션을 이어서 시작하기");

    flushSync(() => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();

    expect(onContinueSession).toHaveBeenCalledWith("session-a");
  });

  it("keeps the continue-session action visible but disabled with a reason", () => {
    ({ container, root } = renderMenu({
      onContinueSession: vi.fn().mockResolvedValue(undefined),
      getContinueSessionDisabledReason: () => "에이전트 정보가 없어 이어서 시작할 수 없습니다.",
    }));

    const item = findMenuItem("이 세션을 이어서 시작하기");

    expect(item.getAttribute("aria-disabled") ?? item.getAttribute("data-disabled")).toBeTruthy();
    expect(item.getAttribute("title")).toBe("에이전트 정보가 없어 이어서 시작할 수 없습니다.");
  });

  it("shows continue-session failures instead of swallowing them", async () => {
    ({ container, root } = renderMenu({
      onContinueSession: vi.fn().mockRejectedValue(new Error("node unavailable")),
      getContinueSessionDisabledReason: () => null,
    }));

    const item = findMenuItem("이 세션을 이어서 시작하기");

    flushSync(() => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.body.textContent).toContain("세션 이어서 시작 실패");
    expect(document.body.textContent).toContain("node unavailable");
  });
});
