/** @vitest-environment jsdom */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFolderChecklistStore, type FolderSnapshot } from "../stores/folder-checklist-store";
import { TaskCard } from "./TaskCard";

const time = "2026-07-17T00:00:00Z";
function snapshot(checklistEnabled: boolean): FolderSnapshot {
  return {
    folder: {
      id: "folder-1", name: "배포 업무", parentFolderId: null, projectPageId: "page-1",
      checklistEnabled, status: "open", archived: false, version: 2,
      createdSessionId: null, createdEventId: null, completedKind: null,
      completedSessionId: null, completedEventId: null, completedUserId: null,
      completedAt: null, createdAt: time, updatedAt: time,
    },
    sections: [{
      id: "section-1", folderId: "folder-1", positionKey: "a", title: "검수",
      archived: false, version: 1, assigneeKind: null, assigneeAgentId: null,
      assigneeSessionId: null, assigneeUserId: null, createdSessionId: null,
      createdEventId: null, updatedSessionId: null, updatedEventId: null,
      createdAt: time, updatedAt: time,
    }],
    items: [{
      id: "item-1", sectionId: "section-1", positionKey: "a", title: "릴리스 확인",
      howTo: "배포를 확인한다", status: "pending", archived: false, version: 1,
      assigneeKind: null, assigneeAgentId: null, assigneeSessionId: null,
      assigneeUserId: null, createdSessionId: null, createdEventId: null,
      updatedSessionId: null, updatedEventId: null, completedKind: null,
      completedSessionId: null, completedEventId: null, completedUserId: null,
      completedAt: null, createdAt: time, updatedAt: time,
    }],
  };
}

describe("TaskCard folder checklist", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    useFolderChecklistStore.getState().reset();
  });
  function render(checklistEnabled: boolean, onOpenBoard?: (id: string) => void) {
    useFolderChecklistStore.setState({ byId: {
      "folder-1": { snapshot: snapshot(checklistEnabled), status: "ready", error: null, isRefreshing: false },
    } });
    flushSync(() => root.render(createElement(TaskCard, {
      folderId: "folder-1", fallbackTitle: "대체 이름", onOpenBoard,
    })));
  }

  it("renders the existing checklist controls when enabled", () => {
    render(true);
    expect(container.textContent).toContain("배포 업무");
    expect(container.textContent).toContain("릴리스 확인");
    expect(container.textContent).toContain("0/1");
    expect(container.querySelector('[aria-label="업무 완료"]')).not.toBeNull();
  });

  it("hides checklist and completion controls while preserving folder title and board entry", () => {
    const onOpenBoard = vi.fn();
    render(false, onOpenBoard);
    expect(container.textContent).toContain("배포 업무");
    expect(container.textContent).not.toContain("릴리스 확인");
    expect(container.textContent).not.toContain("0/1");
    expect(container.querySelector('[aria-label="업무 완료"]')).toBeNull();
    const boardButton = container.querySelector<HTMLButtonElement>('[data-testid="task-card-open-board"]');
    boardButton?.click();
    expect(onOpenBoard).toHaveBeenCalledWith("folder-1");
  });
});
