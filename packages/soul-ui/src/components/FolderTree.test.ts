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

function renderFolderTree() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  useDashboardStore.getState().reset();
  useDashboardStore.getState().setCatalog(catalog);

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

  it("restores expanded folders from localStorage", () => {
    localStorage.setItem("soulstream:folder-tree:expanded:v1:root-a", "true");

    ({ container, root } = renderFolderTree());

    expect(container.textContent).toContain("Root A");
    expect(container.textContent).toContain("Child A");
    expect(container.textContent).not.toContain("Grand A");
  });
});
