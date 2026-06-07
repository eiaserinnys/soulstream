/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogFolder, FolderSettings } from "../shared/types";
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

function renderDialog({
  folder = folders[2],
  onConfirm = vi.fn(),
}: {
  folder?: CatalogFolder;
  onConfirm?: (settings: FolderSettings) => void;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(createElement(FolderSettingsDialog, {
      folder,
      folders,
      open: true,
      onOpenChange: vi.fn(),
      onConfirm,
    }));
  });

  return { container, root, onConfirm };
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

  it("resets feed and notification exclusion checkboxes from folder settings", () => {
    ({ container, root } = renderDialog({
      folder: {
        ...folders[2],
        settings: {
          folderPrompt: "Child prompt",
          excludeFromFeed: true,
          excludeFromNotification: true,
        },
      },
    }));

    const feedInput = document.body.querySelector<HTMLInputElement>('input[name="excludeFromFeed"]');
    const notificationInput = document.body.querySelector<HTMLInputElement>('input[name="excludeFromNotification"]');

    expect(feedInput?.checked).toBe(true);
    expect(notificationInput?.checked).toBe(true);
  });

  it("submits notification exclusion beside the existing feed exclusion setting", async () => {
    const onConfirm = vi.fn();
    ({ container, root } = renderDialog({ onConfirm }));

    const notificationInput = document.body.querySelector<HTMLInputElement>('input[name="excludeFromNotification"]');
    expect(notificationInput).not.toBeNull();

    notificationInput!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const saveButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "저장");
    saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      excludeFromFeed: false,
      excludeFromNotification: true,
      folderPrompt: "Child prompt",
    }));
  });
});
