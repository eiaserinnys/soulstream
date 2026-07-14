import { describe, expect, it, vi } from "vitest";

import {
  PlannerRepository,
  type LivePostgresSql,
} from "../src/index.js";

describe("planner repository", () => {
  it("reads a project with one SQL statement over replica tables only", async () => {
    const payload = {
      project: page("project"),
      tasks: [{
        page: page("task"),
        blocks: [],
        runbook_id: "runbook",
        runbook: null,
        project_page_id: "project",
        sessions: [],
        mounted_documents: [],
      }],
      documents: [],
    };
    const harness = createSqlHarness([[{ payload }]]);
    const repository = new PlannerRepository(resolverFor(harness.sql));

    await expect(repository.getProject("project")).resolves.toEqual(payload);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.values).toEqual(expect.arrayContaining(["project", "project"]));
    const query = normalizeSql(harness.calls[0]?.text);
    for (const table of [
      "pages", "blocks", "block_links", "runbooks", "runbook_sections",
      "runbook_items", "board_items", "sessions",
    ]) {
      expect(query).toContain(table);
    }
    expect(query).not.toContain("board_yjs_documents");
    expect(query).not.toContain("board_yjs_updates");
    expect(query).toContain("jsonb_agg(task.payload ORDER BY task.mount_position DESC, task.page_id)");
  });

  it("reads a daily planner with one SQL statement and returns null on a replica miss", async () => {
    const daily = {
      daily: { page: page("daily"), blocks: [], state_vector: "" },
      projects: [],
      memo_blocks: [],
      tasks: [],
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
