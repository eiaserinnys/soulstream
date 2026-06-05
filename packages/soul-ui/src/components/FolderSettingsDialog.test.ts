/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogFolder } from "../shared/types";
import { FolderSettingsDialog } from "./FolderSettingsDialog";

const folders: CatalogFolder[] = [
  {
    id: "root",
    name: "Root",
    sortOrder: 0,
    parentFolderId: null,
    settings: { folderPrompt: "Root prompt" },
  },
  {
    id: "parent",
    name: "Parent",
    sortOrder: 1,
    parentFolderId: "root",
    settings: { folderPrompt: "" },
  },
  {
    id: "child",
    name: "Child",
    sortOrder: 2,
    parentFolderId: "parent",
    settings: { folderPrompt: "Child prompt" },
  },
];

function renderDialog() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(createElement(FolderSettingsDialog, {
      folder: folders[2],
      folders,
      open: true,
      onOpenChange: vi.fn(),
      onConfirm: vi.fn(),
    }));
  });

  return { container, root };
}

describe("FolderSettingsDialog", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ atom_enabled: false }), { status: 200 })));
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
  });

  it("separates inherited prompt preview from the current folder addition", () => {
    ({ container, root } = renderDialog());

    expect(document.body.textContent).toContain("상속(읽기 전용 미리보기)");
    expect(document.body.textContent).toContain("Root");
    expect(document.body.textContent).toContain("Root prompt");
    expect(document.body.textContent).not.toContain("Parent prompt");
    expect(document.body.textContent).toContain("이 폴더의 추가(편집)");

    const promptInput = document.body.querySelector<HTMLTextAreaElement>('textarea[name="folderPrompt"]');
    expect(promptInput?.value).toBe("Child prompt");
  });
});
