import { describe, expect, it, vi } from "vitest";

import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import {
  createPlannerDataDependencies,
  loadDailyPlanner,
  loadProjectPlanner,
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
    }));

    await expect(loadDailyPlanner(api, "2026-07-14", { fetchPlanner }))
      .resolves.toMatchObject({
        daily: { page: { id: "daily" } },
        projects: [{ id: "project" }],
        tasks: [{
          page: { id: "task" },
          runbookId: "runbook",
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
    const fetchPlanner = vi.fn(async () => ({ project, tasks, documents: [] }));

    const result = await loadProjectPlanner(api, project, { fetchPlanner });

    expect(result.tasks).toHaveLength(22);
    expect(fetchPlanner).toHaveBeenCalledOnce();
    expect(fetchPlanner).toHaveBeenCalledWith("/api/planner/projects/project%2Fa");
    expectNoPageCalls(api);
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
    runbook_id: "runbook",
    runbook: {
      id: "runbook",
      board_item_id: "runbook:runbook",
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
    sessions: [{ agent_session_id: "session-a" }],
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
