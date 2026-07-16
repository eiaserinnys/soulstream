import { describe, expect, it } from "vitest";

import { BoardRepository } from "../../src/db/repositories/board_repository.js";
import type { SqlClient } from "../../src/db/session_db_types.js";

describe("BoardRepository.listContainerItems", () => {
  it("scopes and enriches a page in one batch query", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: Array.from(strings).join("|"), values });
      return Promise.resolve([
        {
          bi_id: "session:session-1",
          bi_folder_id: "folder-1",
          bi_container_kind: "runbook",
          bi_container_id: "runbook-1",
          bi_membership_kind: "primary",
          bi_source_runbook_item_id: null,
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
          runbook_id: null,
          runbook_title: null,
          runbook_updated_at: null,
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
          runbook_count: 0,
          custom_view_count: 0,
          scanned_items: 2000,
          search_truncated: true,
        },
      ]);
    }) as unknown as SqlClient & { array: (values: unknown[]) => unknown[] };
    sql.array = (values) => values;

    const result = await new BoardRepository(sql).listContainerItems({
      container: { containerKind: "runbook", containerId: "runbook-1" },
      query: "발화",
      includeArchived: false,
      itemTypes: ["session", "markdown"],
      limit: 50,
      cursor: 25,
      scanLimit: 2000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("FROM board_items bi");
    expect(calls[0]?.text).toContain("container_kind");
    expect(calls[0]?.text).toContain("container_id");
    expect(calls[0]?.text).toContain("LEFT JOIN sessions");
    expect(calls[0]?.text).toContain("LEFT JOIN markdown_documents");
    expect(calls[0]?.values).toEqual(expect.arrayContaining([
      "runbook",
      "runbook-1",
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
          containerKind: "runbook",
          containerId: "runbook-1",
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
    const sql = ((_: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([{
      bi_id: null,
      total_count: 275,
      session_count: 175,
      markdown_count: 100,
      subfolder_count: 0,
      asset_count: 0,
      frame_count: 0,
      runbook_count: 0,
      custom_view_count: 0,
    }])) as unknown as SqlClient & { array: (values: unknown[]) => unknown[] };
    sql.array = (values) => values;

    const result = await new BoardRepository(sql).listContainerItems({
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
      runbook: 0,
      custom_view: 0,
    });
    expect(result.scan).toBeNull();
  });
});
