import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CatalogFolder, SessionSummary } from "@seosoyoung/soul-ui";

import { V3Navigation } from "./V3Navigation";

describe("V3Navigation frame contract", () => {
  it("keeps a dedicated scroll body and removes legacy navigation decoration", () => {
    const html = renderToStaticMarkup(
      <V3Navigation
        dates={[{ date: "2026-07-15", label: "오늘" }]}
        selectedDate="2026-07-15"
        folders={[folder("project-a", "프로젝트 A")]}
        selectedFolderId={null}
        reviewSessions={[reviewSession("review-a")]}
        starredTasks={[]}
        starredTasksHasMore={false}
        starredTasksLoading={false}
        todayTaskIds={new Set()}
        onLoadMoreStarredTasks={vi.fn()}
        onSelectDate={vi.fn()}
        onOpenReviewQueue={vi.fn()}
        onSelectFolder={vi.fn()}
        onSelectTask={vi.fn()}
        onCompleteTask={vi.fn(async () => undefined)}
        onToggleTaskToday={vi.fn(async () => undefined)}
        onCreateProject={vi.fn(async () => undefined)}
        onCreateTask={vi.fn()}
        onRenameSession={vi.fn(async () => undefined)}
        onDeleteSessions={vi.fn(async () => undefined)}
      />,
    );

    expect(html).toContain('data-testid="v3-navigation-scroll"');
    expect(html).not.toContain("◆");
    expect(html).not.toContain("업무는 프로젝트에 누적되고");
    expect(html).toContain("새 업무");
  });
});

function folder(id: string, name: string): CatalogFolder {
  return { id, name, parentFolderId: null, sortOrder: 0 };
}

function reviewSession(agentSessionId: string): SessionSummary {
  return {
    agentSessionId,
    status: "completed",
    reviewRequired: true,
    reviewState: "needs_review",
    eventCount: 1,
    displayName: "검수 세션",
  };
}
