/**
 * @vitest-environment jsdom
 */

import { DndContext } from "@dnd-kit/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogState } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { FolderTree } from "./FolderTree";

const catalog: CatalogState = {
  folders: [
    { id: "root-a", name: "Root A", sortOrder: 0, parentFolderId: null },
    { id: "child-a", name: "Child A", sortOrder: 0, parentFolderId: "root-a" },
    { id: "grand-a", name: "Grand A", sortOrder: 0, parentFolderId: "child-a" },
    { id: "root-b", name: "Root B", sortOrder: 1, parentFolderId: null },
  ],
  sessions: {},
};

function renderFolderTree(catalogOverride: CatalogState = catalog) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  useDashboardStore.getState().reset();
  useDashboardStore.getState().setCatalog(catalogOverride);

  flushSync(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(DndContext, null, createElement(FolderTree)),
      ),
    );
  });

  return { container, root };
}

describe("FolderTree", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ atom_enabled: false }), { status: 200 })));
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });
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
    localStorage.clear();
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("renders only root folders until a user expands child folders", () => {
    ({ container, root } = renderFolderTree());

    expect(container.textContent).toContain("Root A");
    expect(container.textContent).toContain("Root B");
    expect(container.textContent).not.toContain("Child A");

    const rootToggle = container.querySelector<HTMLButtonElement>('[data-testid="folder-tree-toggle-root-a"]');
    expect(rootToggle).not.toBeNull();

    flushSync(() => {
      rootToggle?.click();
    });

    expect(container.textContent).toContain("Child A");
    expect(container.textContent).not.toContain("Grand A");

    const childToggle = container.querySelector<HTMLButtonElement>('[data-testid="folder-tree-toggle-child-a"]');
    flushSync(() => {
      childToggle?.click();
    });

    expect(container.textContent).toContain("Grand A");
  });

  it("enables drag handles and indentation guides for every expanded folder depth", () => {
    localStorage.setItem("soulstream:folder-tree:expanded:v1:root-a", "true");
    localStorage.setItem("soulstream:folder-tree:expanded:v1:child-a", "true");

    ({ container, root } = renderFolderTree());

    const draggableFolders = container.querySelectorAll('[data-testid="draggable-folder"]');
    expect(draggableFolders).toHaveLength(4);
    expect((draggableFolders[0] as HTMLElement).className).toContain("dashboard-sidebar-row");
    expect((draggableFolders[0] as HTMLElement).className).not.toContain("liquid-glass-card");
    expect((draggableFolders[0] as HTMLElement).dataset.liquidGlassEnhanced).toBeUndefined();

    const guideLines = container.querySelectorAll('[data-testid="folder-tree-guide-line"]');
    expect(guideLines).toHaveLength(2);
    expect(guideLines[0].className).toContain("border-border/50");

    const childRow = draggableFolders[1] as HTMLElement;
    const grandchildRow = draggableFolders[2] as HTMLElement;
    expect(childRow.style.paddingLeft).toBe("30px");
    expect(grandchildRow.style.paddingLeft).toBe("48px");
  });

  it("keeps dense sidebar folder lists free of per-row liquid glass surfaces", () => {
    const denseCatalog: CatalogState = {
      folders: Array.from({ length: 16 }, (_, index) => ({
        id: `folder-${index}`,
        name: `Folder ${index}`,
        sortOrder: index,
        parentFolderId: null,
      })),
      sessions: {},
    };

    ({ container, root } = renderFolderTree(denseCatalog));

    expect(container.querySelectorAll('[data-testid="draggable-folder"]')).toHaveLength(16);
    expect(container.querySelectorAll(".liquid-glass-card")).toHaveLength(0);
    expect(container.querySelectorAll(".liquid-glass-card__layer")).toHaveLength(0);
  });

  it("restores expanded folders from localStorage", () => {
    localStorage.setItem("soulstream:folder-tree:expanded:v1:root-a", "true");

    ({ container, root } = renderFolderTree());

    expect(container.textContent).toContain("Root A");
    expect(container.textContent).toContain("Child A");
    expect(container.textContent).not.toContain("Grand A");
  });

  it("does not render feed as a folder-tree row", () => {
    ({ container, root } = renderFolderTree());

    expect(container.textContent).not.toContain("피드");
  });

  it("keeps system folders non-draggable and non-editable based on id, not display name", () => {
    ({ container, root } = renderFolderTree({
      folders: [
        { id: "claude", name: "이름이 바뀐 클로드 폴더", sortOrder: -1, parentFolderId: null },
        { id: "normal", name: "Normal", sortOrder: 0, parentFolderId: null },
      ],
      sessions: {},
    }));

    expect(container.textContent).toContain("이름이 바뀐 클로드 폴더");
    expect(container.querySelectorAll('[data-testid="draggable-folder"]')).toHaveLength(1);

    const label = Array.from(container.querySelectorAll("span"))
      .find((element) => element.textContent === "이름이 바뀐 클로드 폴더");
    expect(label).toBeDefined();

    flushSync(() => {
      label?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    expect(container.querySelector("input")).toBeNull();
  });
});
