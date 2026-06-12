/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FolderContextMenu } from "./FolderContextMenu";

function renderMenu(folder: { id: string; name: string }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(
      createElement(FolderContextMenu, {
        target: { x: 10, y: 20, folder },
        onClose: vi.fn(),
        onRename: vi.fn(),
        onOpenSettings: vi.fn(),
        onDelete: vi.fn(),
      }),
    );
  });

  return { container, root };
}

describe("FolderContextMenu", () => {
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
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
  });

  it("hides rename and delete actions for system folders by id", () => {
    ({ container, root } = renderMenu({ id: "claude", name: "이름이 바뀐 클로드 폴더" }));

    expect(document.body.textContent).toContain("설정");
    expect(document.body.textContent).not.toContain("이름 변경");
    expect(document.body.textContent).not.toContain("삭제");
  });
});
