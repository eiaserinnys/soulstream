/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

import { V3Navigation } from "./V3Navigation";

vi.mock("./V3ContextMenu", () => ({
  V3ContextMenu: ({ target, actions }: {
    target: { x: number; y: number } | null;
    actions: readonly { label: string }[];
  }) => target
    ? <div data-testid="v3-context-menu">{actions.map((action) => <span key={action.label}>{action.label}</span>)}</div>
    : null,
}));

describe("V3Navigation frame contract", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
  });

  it("keeps a dedicated scroll body and removes legacy navigation decoration", () => {
    const html = renderToStaticMarkup(
      <V3Navigation
        dates={[{ date: "2026-07-15", label: "오늘" }]}
        selectedDate="2026-07-15"
        folders={[folder("project-a", "프로젝트 A")]}
        selectedFolderId={null}
        starredTasks={[]}
        starredTasksHasMore={false}
        starredTasksLoading={false}
        todayTaskIds={new Set()}
        completedTaskIds={new Set()}
        onLoadMoreStarredTasks={vi.fn()}
        onReorderStarredTasks={vi.fn(async () => undefined)}
        onSelectDate={vi.fn()}
        onSelectFolder={vi.fn()}
        onSelectTask={vi.fn()}
        onCompleteTask={vi.fn(async () => undefined)}
        onToggleTaskToday={vi.fn(async () => undefined)}
        onMoveTaskToProject={vi.fn()}
        onCreateProject={vi.fn(async (title, parentFolderId) => ({ id: "created", name: title, sortOrder: 0, parentFolderId, projectPageId: "created" }))}
        onRenameProject={vi.fn(async () => undefined)}
        onDeleteProject={vi.fn(async () => undefined)}
        onReorderProjects={vi.fn(async () => undefined)}
        projectHasContents={vi.fn(() => false)}
        onCreateTask={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="v3-navigation-scroll"');
    expect(html).not.toContain("◆");
    expect(html).not.toContain("업무는 프로젝트에 누적되고");
    expect(html).not.toContain("검수 대기");
    expect(html).toContain("새 업무");
  });

  it("keeps task opening separate from an accessible drag handle", () => {
    const html = renderToStaticMarkup(
      <V3Navigation
        dates={[]}
        selectedDate="2026-07-15"
        folders={[]}
        selectedFolderId={null}
        starredTasks={[{
          id: "starred-a",
          title: "중요 작업 A",
          daily_date: null,
          version: 1,
          archived: false,
          metadata: { starred: true },
          created_at: "2026-07-15T00:00:00Z",
          updated_at: "2026-07-15T00:00:00Z",
        } as never]}
        starredTasksHasMore={true}
        starredTasksLoading={false}
        todayTaskIds={new Set()}
        completedTaskIds={new Set()}
        onLoadMoreStarredTasks={vi.fn()}
        onReorderStarredTasks={vi.fn(async () => undefined)}
        onSelectDate={vi.fn()}
        onSelectFolder={vi.fn()}
        onSelectTask={vi.fn()}
        onCompleteTask={vi.fn(async () => undefined)}
        onToggleTaskToday={vi.fn(async () => undefined)}
        onMoveTaskToProject={vi.fn()}
        onCreateProject={vi.fn(async (title, parentFolderId) => ({ id: "created", name: title, sortOrder: 0, parentFolderId, projectPageId: "created" }))}
        onRenameProject={vi.fn(async () => undefined)}
        onDeleteProject={vi.fn(async () => undefined)}
        onReorderProjects={vi.fn(async () => undefined)}
        projectHasContents={vi.fn(() => false)}
        onCreateTask={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="v3-starred-task-row-starred-a"');
    expect(html).toContain('aria-label="중요 작업 중요 작업 A 순서 변경"');
    expect(html).toContain('data-testid="v3-load-more-starred-tasks"');
  });

  it("opens the existing task context menu from the drag handle", () => {
    flushSync(() => root.render(
      <V3Navigation
        dates={[]}
        selectedDate="2026-07-15"
        folders={[]}
        selectedFolderId={null}
        starredTasks={[{
          id: "starred-a",
          title: "중요 작업 A",
          daily_date: null,
          version: 1,
          archived: false,
          metadata: { starred: true },
          created_at: "2026-07-15T00:00:00Z",
          updated_at: "2026-07-15T00:00:00Z",
        } as never]}
        starredTasksHasMore={false}
        starredTasksLoading={false}
        todayTaskIds={new Set()}
        completedTaskIds={new Set()}
        onLoadMoreStarredTasks={vi.fn()}
        onReorderStarredTasks={vi.fn(async () => undefined)}
        onSelectDate={vi.fn()}
        onSelectFolder={vi.fn()}
        onSelectTask={vi.fn()}
        onCompleteTask={vi.fn(async () => undefined)}
        onToggleTaskToday={vi.fn(async () => undefined)}
        onMoveTaskToProject={vi.fn()}
        onCreateProject={vi.fn(async (title, parentFolderId) => ({ id: "created", name: title, sortOrder: 0, parentFolderId, projectPageId: "created" }))}
        onRenameProject={vi.fn(async () => undefined)}
        onDeleteProject={vi.fn(async () => undefined)}
        onReorderProjects={vi.fn(async () => undefined)}
        projectHasContents={vi.fn(() => false)}
        onCreateTask={vi.fn()}
      />,
    ));
    const handle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="중요 작업 중요 작업 A 순서 변경"]',
    );
    expect(handle).not.toBeNull();
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 40,
    });
    flushSync(() => handle!.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    const contextMenu = container.querySelector('[data-testid="v3-context-menu"]')?.textContent ?? "";
    for (const label of ["업무 열기", "별표 해제", "다른 프로젝트로 이동", "완료 처리"]) {
      expect(contextMenu).toContain(label);
    }
  });
});

function folder(id: string, name: string): CatalogFolder {
  return { id, name, parentFolderId: null, sortOrder: 0 };
}
