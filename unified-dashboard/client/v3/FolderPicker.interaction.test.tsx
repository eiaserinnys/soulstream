/** @vitest-environment jsdom */
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import { FolderPicker } from "./FolderPicker";

describe("FolderPicker", () => {
  let container: HTMLDivElement;
  let root: Root;
  const folders: CatalogFolder[] = [
    folder("root", "Root"), folder("child", "Child", "root"),
    folder("leaf", "Leaf", "child"), folder("other", "Other"),
  ];
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { flushSync(() => root.unmount()); document.body.replaceChildren(); });

  it("defaults to stars, selects without confirming, and disables current targets", () => {
    const onSelect = vi.fn();
    render(["child", "other"], ["child"], onSelect);
    expect(tab("별표").getAttribute("aria-selected")).toBe("true");
    expect(rows()).toEqual(["child", "other"]);
    expect(row("child").getAttribute("aria-disabled")).toBe("true");
    click(row("other").querySelector("button")!);
    expect(onSelect).toHaveBeenCalledWith(folders[3]);
  });

  it("starts collapsed, expands matching ancestors, and restores local expansion after search", () => {
    render([], []);
    expect(tab("전체").getAttribute("aria-selected")).toBe("true");
    expect(rows()).toEqual(["other", "root"]);
    click(button("Root 펼치기"));
    expect(rows()).toEqual(["other", "root", "child"]);
    search("Leaf");
    expect(rows()).toEqual(["root", "child", "leaf"]);
    expect(button("Child 접기").getAttribute("aria-expanded")).toBe("true");
    search("");
    expect(rows()).toEqual(["other", "root", "child"]);
    expect(localStorage.getItem("soulstream:folder-tree:expanded:v1:root")).toBeNull();
  });

  function render(starredFolderIds: string[], disabledFolderIds: string[], onSelect = vi.fn()) {
    flushSync(() => root.render(<FolderPicker folders={folders} starredFolderIds={starredFolderIds}
      disabledFolderIds={new Set(disabledFolderIds)} selectedFolderId={null} pending={false} onSelect={onSelect} />));
  }
  function rows() { return [...container.querySelectorAll("[role=treeitem]")].map((row) => row.getAttribute("data-folder-id")); }
  function row(id: string) { return container.querySelector<HTMLElement>(`[data-folder-id="${id}"]`)!; }
  function tab(name: string) { return [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((tab) => tab.textContent === name)!; }
  function button(label: string) { return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!; }
  function click(element: HTMLElement) { flushSync(() => element.click()); }
  function search(value: string) {
    const input = container.querySelector("input")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
});

function folder(id: string, name: string, parentFolderId: string | null = null): CatalogFolder {
  return { id, name, parentFolderId, projectPageId: `page-${id}`, sortOrder: 0,
    checklistEnabled: false, status: "open", version: 1, archived: false };
}
