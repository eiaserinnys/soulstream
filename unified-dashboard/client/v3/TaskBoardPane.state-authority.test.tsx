/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { CatalogState, SessionSummary } from "@seosoyoung/soul-ui";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskBoardPane } from "./TaskBoardPane";

vi.mock("../components/BoardWorkspaceView", () => ({
  BoardWorkspaceView: () => <div data-testid="scoped-task-board" />,
}));
vi.mock("../providers", () => ({ orchestratorSessionProvider: {} }));
vi.mock("./task-inline-board-api", () => ({
  fetchTaskBoardContainerItems: vi.fn(async () => []),
}));
vi.mock("./v3-live-invalidation-plane", () => ({
  useV3InvalidationKey: () => 0,
  useV3PageInvalidationKey: () => 0,
}));
vi.mock("@seosoyoung/soul-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seosoyoung/soul-ui")>();
  return {
    ...actual,
    useSessionListProvider: () => ({ sessions: [], loading: false }),
  };
});

describe("TaskBoardPane catalog ownership", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useDashboardStore.getState().reset();
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    useDashboardStore.getState().reset();
    container.remove();
  });

  it("keeps a session status received while the board is open after it closes", async () => {
    useDashboardStore.getState().setCatalog(catalog("running"));
    flushSync(() => root.render(
      <TaskBoardPane
        taskId="task-a"
        projectFolderId="project-a"
        projectTitle="Project A"
        sessions={[]}
        taskMoveTargets={[]}
        onBoardItemsChanged={() => undefined}
        onMarkdownDocumentDeleted={() => undefined}
        onOpenMarkdownDocument={() => undefined}
        onRequestMarkdownEdit={() => undefined}
        onOpenCustomView={() => undefined}
        onClose={() => undefined}
      />,
    ));

    await vi.waitFor(() => expect(container.querySelector("[data-testid='scoped-task-board']")).not.toBeNull());
    useDashboardStore.getState().setCatalog(catalog("completed"));
    flushSync(() => root.unmount());

    expect(useDashboardStore.getState().catalog?.sessionList?.[0]?.status).toBe("completed");
  });
});

function catalog(status: SessionSummary["status"]): CatalogState {
  return {
    folders: [{ id: "project-a", name: "Project A", sortOrder: 0, projectPageId: null }],
    sessions: {},
    boardItems: [],
    sessionList: [{
      agentSessionId: "session-a",
      status,
      reviewState: "not_required",
      updatedAt: "2026-09-27T00:00:00Z",
      eventCount: 0,
    } as SessionSummary],
  };
}
