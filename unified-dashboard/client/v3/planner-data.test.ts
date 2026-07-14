import { describe, expect, it, vi } from "vitest";

import type {
  BlockDto,
  PageApiClient,
  PageDto,
  PageReadResponse,
} from "@seosoyoung/soul-ui/page";

import {
  loadDailyPlanner,
  loadProjectPlanner,
  type PlannerDataDependencies,
} from "./planner-data";

describe("planner data concurrency", () => {
  it("starts a task backlink, runbook, and run-session lookup together", async () => {
    const backlink = deferred<Awaited<ReturnType<PageApiClient["getBacklinks"]>>>();
    const runbook = deferred<null>();
    const sessionIds = deferred<string[]>();
    const api = dailyApi([taskRead("task-a", "업무 A", "rb-a")], backlink.promise);
    const dependencies = dependenciesFor({
      fetchRunbook: vi.fn(() => runbook.promise),
      fetchRunbookSessionIds: vi.fn(() => sessionIds.promise),
    });

    const pending = loadDailyPlanner(api, "2026-07-14", dependencies);
    await vi.waitFor(() => {
      expect(api.getBacklinks).toHaveBeenCalledWith("task-a", { kinds: ["mount"], limit: 50 });
      expect(dependencies.fetchRunbook).toHaveBeenCalledWith("rb-a");
      expect(dependencies.fetchRunbookSessionIds).toHaveBeenCalledWith("rb-a");
    });
    expect(api.getBacklinks).toHaveBeenCalledTimes(1);
    expect(dependencies.fetchRunbook).toHaveBeenCalledTimes(1);
    expect(dependencies.fetchRunbookSessionIds).toHaveBeenCalledTimes(1);

    backlink.resolve({ items: [{ sourcePageId: "project-a" }] } as never);
    runbook.resolve(null);
    sessionIds.resolve(["session-a"]);
    await expect(pending).resolves.toMatchObject({
      tasks: [{ projectPageId: "project-a", sessionIds: ["session-a"] }],
    });
  });

  it("loads every project task without waiting for the previous task", async () => {
    const runbooks = new Map([
      ["rb-a", deferred<null>()],
      ["rb-b", deferred<null>()],
    ]);
    const sessions = new Map([
      ["rb-a", deferred<string[]>()],
      ["rb-b", deferred<string[]>()],
    ]);
    const project = page("project-a", "프로젝트 A", { starred: true });
    const tasks = [
      taskRead("task-a", "업무 A", "rb-a"),
      taskRead("task-b", "업무 B", "rb-b"),
    ];
    const api = projectApi(project, tasks);
    const dependencies = dependenciesFor({
      fetchRunbook: vi.fn((id: string) => runbooks.get(id)!.promise),
      fetchRunbookSessionIds: vi.fn((id: string) => sessions.get(id)!.promise),
    });

    const pending = loadProjectPlanner(api, project, dependencies);
    await vi.waitFor(() => {
      expect(dependencies.fetchRunbook).toHaveBeenCalledTimes(2);
      expect(dependencies.fetchRunbookSessionIds).toHaveBeenCalledTimes(2);
    });

    runbooks.get("rb-a")!.resolve(null);
    runbooks.get("rb-b")!.resolve(null);
    sessions.get("rb-a")!.resolve(["session-a"]);
    sessions.get("rb-b")!.resolve(["session-b"]);
    await expect(pending).resolves.toMatchObject({
      tasks: expect.arrayContaining([
        expect.objectContaining({ runbookId: "rb-a", sessionIds: ["session-a"] }),
        expect.objectContaining({ runbookId: "rb-b", sessionIds: ["session-b"] }),
      ]),
    });
  });
});

function dailyApi(
  tasks: PageReadResponse[],
  backlinkPromise: Promise<Awaited<ReturnType<PageApiClient["getBacklinks"]>>>,
): PageApiClient {
  const project = page("project-a", "프로젝트 A", { starred: true });
  const daily = pageRead("daily", "2026-07-14", tasks.map((task, index) => (
    block(`mount-${index}`, "paragraph", `[[${task.page.title}]]`)
  )));
  const byId = new Map([daily, ...tasks].map((item) => [item.page.id, item]));
  return {
    getDailyPage: vi.fn(async () => ({ page: daily.page })),
    getPage: vi.fn(async (id: string) => byId.get(id)!),
    listPages: vi.fn(async ({ starred }: { starred?: boolean }) => ({
      items: starred ? [project] : tasks.map((task) => task.page),
      next_cursor: null,
    })),
    getBacklinks: vi.fn(() => backlinkPromise),
  } as unknown as PageApiClient;
}

function projectApi(project: PageDto, tasks: PageReadResponse[]): PageApiClient {
  const projectRead = pageRead(project.id, project.title, tasks.map((task, index) => (
    block(`mount-${index}`, "paragraph", `[[${task.page.title}]]`)
  )), project.metadata);
  const byId = new Map([projectRead, ...tasks].map((item) => [item.page.id, item]));
  return {
    getPage: vi.fn(async (id: string) => byId.get(id)!),
    listPages: vi.fn(async () => ({
      items: tasks.map((task) => task.page),
      next_cursor: null,
    })),
  } as unknown as PageApiClient;
}

function dependenciesFor(overrides: Partial<PlannerDataDependencies>): PlannerDataDependencies {
  return {
    fetchRunbook: async () => null,
    fetchRunbookSessionIds: async () => [],
    ...overrides,
  };
}

function taskRead(id: string, title: string, runbookId: string): PageReadResponse {
  return pageRead(id, title, [
    block(`${id}-runbook`, "runbook_ref", "", { runbookId, primary: true }),
  ]);
}

function pageRead(
  id: string,
  title: string,
  blocks: BlockDto[],
  metadata: Record<string, unknown> = {},
): PageReadResponse {
  return {
    page: page(id, title, metadata),
    blocks,
    state_vector: "",
  };
}

function page(id: string, title: string, metadata: Record<string, unknown> = {}): PageDto {
  return {
    id,
    title,
    daily_date: null,
    version: 1,
    archived: false,
    metadata,
    created_at: "2026-07-14T00:00:00Z",
    updated_at: "2026-07-14T00:00:00Z",
  };
}

function block(
  id: string,
  blockType: string,
  text: string,
  properties: Record<string, unknown> = {},
): BlockDto {
  return {
    id,
    page_id: "page",
    parent_id: null,
    position_key: id,
    block_type: blockType,
    text,
    properties,
    collapsed: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
