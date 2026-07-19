/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectNavigationTree } from "./ProjectNavigationTree";

describe("ProjectNavigationTree expansion", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("starts collapsed and restores the shared v1 expansion key", () => {
    render();
    expect(container.textContent).not.toContain("Child");
    expect(container.querySelectorAll(".v3-project-tree-icon")).toHaveLength(1);

    button("Root 펼치기").click();
    expect(container.textContent).toContain("Child");
    expect(localStorage.getItem("soulstream:folder-tree:expanded:v1:root")).toBe("true");

    flushSync(() => root.unmount());
    container.replaceChildren();
    root = createRoot(container);
    render();
    expect(container.textContent).toContain("Child");
    expect(container.querySelectorAll(".v3-project-tree-icon")).toHaveLength(2);
  });

  function render() {
    flushSync(() => root.render(
      <ProjectNavigationTree
        folders={[
          { id: "root", name: "Root", sortOrder: 0, parentFolderId: null },
          { id: "child", name: "Child", sortOrder: 0, parentFolderId: "root" },
        ]}
        selectedFolderId={null}
        isExpanded={(folderId) => localStorage.getItem(`soulstream:folder-tree:expanded:v1:${folderId}`) === "true"}
        onToggleExpanded={(folderId) => {
          const key = `soulstream:folder-tree:expanded:v1:${folderId}`;
          localStorage.setItem(key, String(localStorage.getItem(key) !== "true"));
          render();
        }}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onReorder={vi.fn(async () => undefined)}
      />,
    ));
  }

  function button(label: string): HTMLButtonElement {
    const target = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!target) throw new Error(`${label} 버튼을 찾지 못했습니다.`);
    return target;
  }
});
