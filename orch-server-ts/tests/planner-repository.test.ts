import { describe, expect, it, vi } from "vitest";

import {
  PlannerRepository,
  type LivePostgresSql,
} from "../src/index.js";

describe("planner repository", () => {
  it("reads a project with one SQL statement over replica tables only", async () => {
    const payload = {
      project: page("project"),
      tasks: { items: [{
        page: page("task"),
        blocks: [],
        task_id: "task",
        task: null,
        project_page_id: "project",
        sessions: [],
        mounted_documents: [],
      }], next_cursor: null },
      documents: { items: [], next_cursor: null },
    };
    const harness = createSqlHarness([[{
      payload: {
        project: payload.project,
        tasks: payload.tasks.items,
        documents: payload.documents.items,
      },
      next_task_position: null,
      next_task_id: null,
      next_document_position: null,
      next_document_id: null,
    }]]);
    const repository = new PlannerRepository(resolverFor(harness.sql));

    await expect(repository.getProject("project", { limit: 20 })).resolves.toEqual(payload);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.values).toEqual(expect.arrayContaining(["project", "project"]));
    const query = normalizeSql(harness.calls[0]?.text);
    for (const table of [
      "pages", "blocks", "block_links", "tasks", "task_sections",
      "task_items", "board_items", "sessions",
    ]) {
      expect(query).toContain(table);
    }
    expect(query).not.toContain("board_yjs_documents");
    expect(query).not.toContain("board_yjs_updates");
    expect(query).not.toContain("jsonb_typeof(p.metadata->'starred')");
    expect(query).toContain("b.block_type IN ('task_ref', 'runbook_ref')");
    expect(query).toContain("WHEN 'runbook_ref' THEN NULLIF(BTRIM(b.properties->>'runbookId'), '')");
    expect(query).toContain("ORDER BY CASE b.block_type WHEN 'task_ref' THEN 0 ELSE 1 END");
    expect(query).toContain("LEFT JOIN LATERAL");
    expect(query).toContain("identity.block_type IN ('task_ref', 'runbook_ref')");
    expect(query).toContain("WHEN 'runbook_ref' THEN identity.properties->>'runbookId'");
    expect(query).toContain("project_link.link_kind = 'mount'");
    expect(query).toContain("folder_task_mounts AS");
    expect(query).toContain("board_item.membership_kind = 'primary'");
    expect(query).toContain("task.task_page_id IS NOT NULL");
    expect(query).toContain("LIMIT ?");
    expect(query).toContain("ORDER BY session.updated_at DESC, session.session_id DESC LIMIT 1");
  });

  it("reads a daily planner with one SQL statement and returns null on a replica miss", async () => {
    const daily = {
      daily: { page: page("daily"), blocks: [], state_vector: "" },
      projects: [],
      memo_blocks: [],
      tasks: [],
      review_session_ids: ["review-session"],
    };
    const harness = createSqlHarness([[{ payload: daily }], [{ payload: null }]]);
    const repository = new PlannerRepository(resolverFor(harness.sql));

    await expect(repository.getToday("2026-07-14")).resolves.toEqual(daily);
    await expect(repository.getToday("2026-07-13")).resolves.toBeNull();
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]?.values).toEqual(
      expect.arrayContaining(["today", "2026-07-14"]),
    );
    expect(normalizeSql(harness.calls[0]?.text)).toContain(
      "jsonb_agg(task.payload ORDER BY task.mount_position ASC, task.page_id)",
    );
    expect(normalizeSql(harness.calls[0]?.text)).toContain("session.review_state = 'needs_review'");
    expect(normalizeSql(harness.calls[0]?.text)).toContain("LIMIT 50");
  });

  it("indexes only starred primary-task pages with keyset limits", async () => {
    const harness = createSqlHarness([
      [
        { payload: page("project-a"), updated_at_cursor: "2026-07-14T00:00:00.000Z", id: "project-a" },
        { payload: page("project-b"), updated_at_cursor: "2026-07-13T00:00:00.000Z", id: "project-b" },
      ],
      [{ daily_date: "2026-07-13" }, { daily_date: "2026-07-11" }],
      [{
        task_id: "task-a",
        runs: [
          { agent_session_id: "session-a", updated_at_cursor: "2026-07-14T00:00:00.000Z" },
          { agent_session_id: "session-b", updated_at_cursor: "2026-07-13T00:00:00.000Z" },
        ],
        total: 61,
      }],
    ]);
    const repository = new PlannerRepository(resolverFor(harness.sql));

    const tasks = await repository.getStarredTasks({ limit: 1 });
    const history = await repository.getDailyHistory({ before: "2026-07-14", limit: 2 });
    const runs = await repository.getTaskRuns("task-a", { limit: 1 });

    expect(tasks).toMatchObject({ items: [{ id: "project-a" }] });
    expect(tasks.next_cursor).toEqual(expect.any(String));
    expect(history).toEqual({ dates: ["2026-07-13", "2026-07-11"] });
    expect(runs).toMatchObject({
      items: [{ agent_session_id: "session-a" }],
      total: 61,
      next_cursor: expect.any(String),
    });

    const taskQuery = normalizeSql(harness.calls[0]?.text);
    expect(taskQuery).toContain("COALESCE((p.metadata->>'starred')::boolean, FALSE)");
    expect(taskQuery).toContain("b.block_type IN ('task_ref', 'runbook_ref')");
    expect(taskQuery).toContain("COALESCE((b.properties->>'primary')::boolean, FALSE)");
    expect(taskQuery).toContain("WHEN 'runbook_ref' THEN b.properties->>'runbookId'");
    expect(taskQuery).toContain("LIMIT ?");
    expect(harness.calls[0]?.values).toContain(2);
    const runQuery = normalizeSql(harness.calls[2]?.text);
    expect(runQuery).toContain("b.block_type IN ('task_ref', 'runbook_ref')");
    expect(runQuery).toContain("WHEN 'runbook_ref' THEN NULLIF(BTRIM(b.properties->>'runbookId'), '')");
    expect(runQuery).toContain("ORDER BY CASE b.block_type WHEN 'task_ref' THEN 0 ELSE 1 END");
    expect(runQuery).toContain("container_kind = 'task'");
    expect(runQuery).toContain("ORDER BY updated_at DESC, session_id DESC");
    expect(harness.calls[2]?.values).toContain(2);
  });

  it("returns full starred task aggregates without changing the default page query", async () => {
    const fullTask = {
      page: page("task-page"),
      blocks: [],
      task_id: "task-id",
      task: null,
      project_page_id: "project-page",
      sessions: [],
      mounted_documents: [],
    };
    const harness = createSqlHarness([[
      {
        id: "task-page",
        updated_at_cursor: "2026-07-14T00:00:00.000Z",
        payload: fullTask,
      },
    ]]);
    const repository = new PlannerRepository(resolverFor(harness.sql));

    await expect(repository.getStarredTasks({ limit: 50, detail: "full" })).resolves.toEqual({
      items: [fullTask],
      next_cursor: null,
    });
    const query = normalizeSql(harness.calls[0]?.text);
    expect(query).toContain("task_summaries AS");
    expect(query).toContain("task_sessions AS");
    expect(query).toContain("mounted_documents AS");
    expect(query).toContain("COALESCE((page.metadata->>'starred')::boolean, FALSE)");
  });
});

function createSqlHarness(results: readonly (readonly Record<string, unknown>[])[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(results[calls.length - 1] ?? []);
  });
  return { calls, sql: query as unknown as LivePostgresSql };
}

function resolverFor(sql: LivePostgresSql) {
  return {
    resolveSql: vi.fn(async () => sql),
    close: vi.fn(async () => undefined),
  };
}

function normalizeSql(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function page(id: string) {
  return {
    id,
    title: id,
    daily_date: null,
    version: 1,
    archived: false,
    metadata: {},
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
  };
}
