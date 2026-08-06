import { describe, expect, it, vi } from "vitest";

import { BoardProjectionReadRepository } from
  "../src/board-yjs/board_projection_read_repository.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";

interface SqlCall {
  query: string;
  values: unknown[];
}

function createMockSql(
  resultFor: (call: SqlCall) => readonly Record<string, unknown>[],
): { sql: LivePostgresSql; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { query: Array.from(strings).join("?"), values };
      calls.push(call);
      return Promise.resolve(resultFor(call));
    },
    {
      array: (values: readonly unknown[]) => values,
      json: (value: unknown) => value,
      begin: async <T>(callback: (transaction: LivePostgresSql) => Promise<T>) =>
        await callback(sql as unknown as LivePostgresSql),
    },
  ) as unknown as LivePostgresSql;
  return { sql, calls };
}

describe("BoardProjectionReadRepository.listContainerItems", () => {
  it("scopes and enriches a page in one orchestrator query", async () => {
    const { sql, calls } = createMockSql(() => [{
      bi_id: "session:session-1",
      bi_folder_id: "folder-1",
      bi_container_kind: "task",
      bi_container_id: "task-1",
      bi_membership_kind: "primary",
      bi_source_task_item_id: null,
      bi_item_type: "session",
      bi_item_id: "session-1",
      bi_x: 10,
      bi_y: 20,
      bi_metadata: {},
      bi_created_at: new Date("2026-07-16T00:00:00.000Z"),
      bi_updated_at: new Date("2026-07-16T00:01:00.000Z"),
      item_archived: false,
      session_display_name: null,
      session_status: "running",
      session_type: "codex",
      session_created_at: new Date("2026-07-16T00:00:00.000Z"),
      session_updated_at: new Date("2026-07-16T00:02:00.000Z"),
      session_event_count: 2,
      session_away_summary: null,
      session_caller_session_id: "parent",
      session_predecessor_session_id: null,
      session_node_id: "node-a",
      session_agent_id: "roselin_codex",
      session_last_event_id: 2,
      session_last_read_event_id: 1,
      session_last_user_preview: "최신 사용자 발화",
      markdown_id: null,
      markdown_title: null,
      markdown_body: null,
      markdown_updated_at: null,
      task_id: null,
      task_title: null,
      task_updated_at: null,
      custom_view_id: null,
      custom_view_title: null,
      custom_view_updated_at: null,
      asset_id: null,
      asset_title: null,
      asset_updated_at: null,
      subfolder_id: null,
      subfolder_title: null,
      total_count: 1,
      session_count: 1,
      markdown_count: 0,
      subfolder_count: 0,
      asset_count: 0,
      frame_count: 0,
      task_count: 0,
      custom_view_count: 0,
      scanned_items: 2000,
      search_truncated: true,
    }]);
    const repository = new BoardProjectionReadRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    const result = await repository.listContainerItems({
      container: { containerKind: "task", containerId: "task-1" },
      query: "발화",
      includeArchived: false,
      itemTypes: ["session", "markdown"],
      limit: 50,
      cursor: 25,
      scanLimit: 2000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("FROM board_items bi");
    expect(calls[0]?.query).toContain("LEFT JOIN sessions");
    expect(calls[0]?.query).toContain("LEFT JOIN markdown_documents");
    expect(calls[0]?.values).toEqual(expect.arrayContaining([
      "task",
      "task-1",
      "발화",
      false,
      ["session", "markdown"],
      50,
      25,
      2000,
      2001,
    ]));
    expect(result.total).toBe(1);
    expect(result.counts.session).toBe(1);
    expect(result.scan).toEqual({
      limit: 2000,
      scannedItems: 2000,
      truncated: true,
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        archived: false,
        boardItem: expect.objectContaining({
          itemType: "session",
          itemId: "session-1",
          containerKind: "task",
          containerId: "task-1",
        }),
        session: expect.objectContaining({
          agentSessionId: "session-1",
          lastUserMessagePreview: "최신 사용자 발화",
          agentId: "roselin_codex",
          eventCount: 2,
        }),
      }),
    ]);
  });

  it("returns totals for an empty page from the sentinel row", async () => {
    const { sql } = createMockSql(() => [{
      bi_id: null,
      total_count: 275,
      session_count: 175,
      markdown_count: 100,
      subfolder_count: 0,
      asset_count: 0,
      frame_count: 0,
      task_count: 0,
      custom_view_count: 0,
    }]);
    const repository = new BoardProjectionReadRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    const result = await repository.listContainerItems({
      container: { containerKind: "folder", containerId: "folder-1" },
      query: null,
      includeArchived: false,
      itemTypes: null,
      limit: 50,
      cursor: 300,
    });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(275);
    expect(result.counts).toEqual({
      session: 175,
      markdown: 100,
      subfolder: 0,
      asset: 0,
      frame: 0,
      task: 0,
      custom_view: 0,
    });
    expect(result.scan).toBeNull();
  });
});
