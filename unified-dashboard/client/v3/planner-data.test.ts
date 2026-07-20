import { describe, expect, it, vi } from "vitest";

import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import {
  createPlannerDataDependencies,
  loadDailyHistoryDates,
  loadDailyPlanner,
  loadProjectDocumentPage,
  loadPlannerTask,
  loadStarredTasks,
  loadStarredPlannerTask,
  loadProjectPlanner,
  loadProjectTaskPage,
  loadTaskRunHistory,
  type PlannerDataDependencies,
} from "./planner-data";

describe("planner BFF data", () => {
  it("loads today in one request without calling the page API fanout", async () => {
    const api = pageApiThatMustStayIdle();
    const fetchPlanner = vi.fn(async () => ({
      daily: { page: page("daily", "2026-07-14"), blocks: [], state_vector: "" },
      projects: [page("project", "프로젝트")],
      memo_blocks: [],
      tasks: [taskPayload()],
      review_session_ids: ["review-session"],
    }));

    await expect(loadDailyPlanner(api, "2026-07-14", { fetchPlanner }))
      .resolves.toMatchObject({
        daily: { page: { id: "daily" } },
        projects: [{ id: "project" }],
        reviewSessionIds: ["review-session"],
        tasks: [{
          page: { id: "task" },
          taskId: "task",
          status: "in_progress",
          assignee: "roselin",
          progress: 25,
          sessionIds: ["session-a"],
          projectPageId: "project",
        }],
      });
    expect(fetchPlanner).toHaveBeenCalledOnce();
    expect(fetchPlanner).toHaveBeenCalledWith("/api/planner/today?date=2026-07-14");
    expectNoPageCalls(api);
  });

  it("loads a 22-task project through one request", async () => {
    const api = pageApiThatMustStayIdle();
    const project = page("project/a", "프로젝트");
    const tasks = Array.from({ length: 22 }, (_, index) => taskPayload(index));
    const fetchPlanner = vi.fn(async () => ({
      project,
      tasks: { items: tasks, next_cursor: "task-next" },
      documents: { items: [], next_cursor: "document-next" },
    }));

    const result = await loadProjectPlanner(api, project, { fetchPlanner });

    expect(result.tasks).toHaveLength(22);
    expect(result.nextTaskCursor).toBe("task-next");
    expect(result.nextDocumentCursor).toBe("document-next");
    expect(fetchPlanner).toHaveBeenCalledOnce();
    expect(fetchPlanner).toHaveBeenCalledWith("/api/planner/projects/project%2Fa");
    expectNoPageCalls(api);
  });

  it("deduplicates daily and project task payloads by page id", async () => {
    const api = pageApiThatMustStayIdle();
    const duplicate = taskPayload();
    const fetchPlanner = vi.fn(async (path: string) => path.startsWith("/api/planner/today")
      ? {
          daily: { page: page("daily", "2026-07-14"), blocks: [], state_vector: "" },
          projects: [],
          memo_blocks: [],
          tasks: [duplicate, duplicate, duplicate, duplicate],
          review_session_ids: [],
        }
      : {
          project: page("project", "프로젝트"),
          tasks: { items: [duplicate, duplicate], next_cursor: null },
          documents: { items: [], next_cursor: null },
        });

    const daily = await loadDailyPlanner(api, "2026-07-14", { fetchPlanner });
    const project = await loadProjectPlanner(
      api,
      page("project", "프로젝트"),
      { fetchPlanner },
    );

    expect(daily.tasks.map((task) => task.page.id)).toEqual(["task"]);
    expect(project.tasks.map((task) => task.page.id)).toEqual(["task"]);
  });

  it("loads bounded project, daily, task, document, and run pages through dedicated planner routes", async () => {
    const fetchPlanner = vi.fn(async (path: string) => {
      if (path.startsWith("/api/planner/starred-tasks")) {
        return { items: [taskPayload()], next_cursor: "task-next" };
      }
      if (path.startsWith("/api/planner/daily-history")) {
        return { dates: ["2026-07-13", "2026-07-11"] };
      }
      if (path.includes("/tasks?")) {
        return { items: [taskPayload()], next_cursor: "task-next" };
      }
      if (path.includes("/documents?")) {
        return { items: [page("document", "문서")], next_cursor: null };
      }
      return {
        items: [{ agent_session_id: "session-a" }],
        next_cursor: "run-next",
        total: 61,
      };
    });
    const dependencies = { fetchPlanner } satisfies PlannerDataDependencies;

    await expect(loadStarredTasks(dependencies, { cursor: "cursor-a", limit: 50 }))
      .resolves.toMatchObject({
        items: [{ page: { id: "task" }, taskId: "task", status: "in_progress" }],
        nextCursor: "task-next",
      });
    await expect(loadDailyHistoryDates(dependencies, "2026-07-14", 2))
      .resolves.toEqual(["2026-07-13", "2026-07-11"]);
    await expect(loadProjectTaskPage(dependencies, "project/a", "cursor-b", 20))
      .resolves.toMatchObject({ items: [{ page: { id: "task" } }], nextCursor: "task-next" });
    await expect(loadProjectDocumentPage(dependencies, "project/a", "cursor-c", 20))
      .resolves.toMatchObject({ items: [{ id: "document" }], nextCursor: null });
    await expect(loadTaskRunHistory(dependencies, "task/a", "cursor-d", 20))
      .resolves.toEqual({ sessionIds: ["session-a"], nextCursor: "run-next", total: 61 });

    expect(fetchPlanner).toHaveBeenCalledWith("/api/planner/starred-tasks?cursor=cursor-a&limit=50&detail=full");
    expect(fetchPlanner).toHaveBeenCalledWith("/api/planner/daily-history?before=2026-07-14&limit=2");
    expect(fetchPlanner).toHaveBeenCalledWith("/api/planner/projects/project%2Fa/tasks?cursor=cursor-b&limit=20");
    expect(fetchPlanner).toHaveBeenCalledWith("/api/planner/projects/project%2Fa/documents?cursor=cursor-c&limit=20");
    expect(fetchPlanner).toHaveBeenCalledWith("/api/planner/tasks/task%2Fa/runs?cursor=cursor-d&limit=20");
  });

  it("uses one authenticated JSON fetch in the production dependency", async () => {
    const response = { daily: { page: { id: "daily" } } };
    const fetchImplementation = vi.fn(async () => ({
      ok: true,
      json: async () => response,
    })) as unknown as typeof globalThis.fetch;
    const dependencies = createPlannerDataDependencies(fetchImplementation);

    await expect(dependencies.fetchPlanner("/api/planner/today?date=2026-07-14"))
      .resolves.toBe(response);
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/planner/today?date=2026-07-14",
      {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      },
    );
  });

  it("opens a full starred task without the legacy page and backlink fanout", async () => {
    const fullTask = {
      page: page("task", "업무"),
      blocks: [],
      stateVector: "",
      taskId: "task",
      task: null,
      status: "open" as const,
      assignee: "담당 미확인",
      contextCount: 0,
      progress: null,
      projectPageId: null,
      sessionIds: [],
      mountedDocuments: [],
    };
    const api = pageApiThatMustStayIdle();

    await expect(loadStarredPlannerTask(api, fullTask)).resolves.toBe(fullTask);
    expectNoPageCalls(api);
  });

  it("preserves the server detail for the collapsed planner error disclosure", async () => {
    const fetchImplementation = vi.fn(async () => new Response(
      JSON.stringify({ detail: "PostgreSQL connection refused at internal-host:5432" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    ));
    const dependencies = createPlannerDataDependencies(fetchImplementation);

    await expect(dependencies.fetchPlanner("/api/planner/today?date=2026-07-14"))
      .rejects.toThrow("PostgreSQL connection refused at internal-host:5432");
  });

  it("resolves a starred task project after paginating past daily mounts", async () => {
    const taskPage = page("task-starred", "별표 업무");
    const taskSnapshot = {
      page: taskPage,
      blocks: [{
        id: "task-ref",
        page_id: taskPage.id,
        parent_id: null,
        position_key: "A",
        block_type: "task_ref",
        text: "",
        properties: { primary: true, taskId: "task-starred" },
        collapsed: false,
      }],
      state_vector: "AA==",
    };
    const daily = { page: { ...page("daily", "오늘"), daily_date: "2026-07-17" }, blocks: [], state_vector: "AA==" };
    const project = { page: page("project", "프로젝트"), blocks: [], state_vector: "AA==" };
    const api = {
      getPage: vi.fn(async (pageId: string) => (
        pageId === taskPage.id ? taskSnapshot : pageId === daily.page.id ? daily : project
      )),
      getBacklinks: vi
        .fn()
        .mockResolvedValueOnce({
          items: [{ sourcePageId: daily.page.id }],
          nextCursor: "next-mounts",
        })
        .mockResolvedValueOnce({
          items: [{ sourcePageId: project.page.id }],
          nextCursor: null,
        }),
    } as unknown as PageApiClient;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    try {
      await expect(loadPlannerTask(api, taskPage.id)).resolves.toMatchObject({
        projectPageId: project.page.id,
      });
      expect(api.getBacklinks).toHaveBeenNthCalledWith(2, taskPage.id, {
        kinds: ["mount"],
        limit: 50,
        cursor: "next-mounts",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function pageApiThatMustStayIdle(): PageApiClient {
  return {
    getDailyPage: vi.fn(),
    getPage: vi.fn(),
    listPages: vi.fn(),
    getBacklinks: vi.fn(),
  } as unknown as PageApiClient;
}

function expectNoPageCalls(api: PageApiClient): void {
  expect(api.getDailyPage).not.toHaveBeenCalled();
  expect(api.getPage).not.toHaveBeenCalled();
  expect(api.listPages).not.toHaveBeenCalled();
  expect(api.getBacklinks).not.toHaveBeenCalled();
}

function taskPayload(index = 0) {
  return {
    page: page(`task${index || ""}`, `업무 ${index}`),
    blocks: [],
    task_id: "task",
    task: {
      id: "task",
      board_item_id: "task:task",
      title: "업무",
      status: "open",
      archived: false,
      version: 2,
      created_session_id: null,
      created_event_id: null,
      created_at: "2026-07-14T00:00:00.000Z",
      updated_at: "2026-07-14T00:00:00.000Z",
      item_counts: { pending: 3, in_progress: 1 },
      item_total: 4,
      completed_item_count: 1,
      assignee: "roselin",
    },
    project_page_id: "project",
    sessions: [{ agent_session_id: `session-${index || "a"}` }],
    mounted_documents: [],
  };
}

function page(id: string, title: string): PageDto {
  return {
    id,
    title,
    daily_date: null,
    version: 1,
    archived: false,
    metadata: {},
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
  };
}
