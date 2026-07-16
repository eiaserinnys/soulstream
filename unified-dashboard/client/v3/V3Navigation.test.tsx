import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

import { V3Navigation } from "./V3Navigation";

describe("V3Navigation frame contract", () => {
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
        onSelectDate={vi.fn()}
        onSelectFolder={vi.fn()}
        onSelectTask={vi.fn()}
        onCompleteTask={vi.fn(async () => undefined)}
        onToggleTaskToday={vi.fn(async () => undefined)}
        onCreateProject={vi.fn(async () => undefined)}
        onCreateTask={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="v3-navigation-scroll"');
    expect(html).not.toContain("◆");
    expect(html).not.toContain("업무는 프로젝트에 누적되고");
    expect(html).not.toContain("검수 대기");
    expect(html).toContain("새 업무");
  });
});

function folder(id: string, name: string): CatalogFolder {
  return { id, name, parentFolderId: null, sortOrder: 0 };
}
