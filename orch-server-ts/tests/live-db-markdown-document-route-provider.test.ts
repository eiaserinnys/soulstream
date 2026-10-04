import { describe, expect, it, vi } from "vitest";

import {
  MarkdownDocumentRouteError,
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  text: string;
  values: unknown[];
};

describe("live DB markdown document route provider", () => {
  it("reads folders and markdown documents with route access folder metadata", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("folder_get_all")) return [folderRow()];
      if (text.includes("FROM markdown_documents")) {
        return [
          {
            id: "doc-1",
            title: "Note",
            body: "Body",
            version: "3",
            folder_id: "folder-a",
            created_at: new Date("2026-07-09T01:00:00.000Z"),
            updated_at: new Date("2026-07-09T01:05:00.000Z"),
          },
        ];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(repository.markdownDocumentRouteProvider.listFolders()).resolves.toEqual([
      expect.objectContaining({ id: "folder-a", parentFolderId: null }),
    ]);
    await expect(
      repository.markdownDocumentRouteProvider.getMarkdownDocument("doc-1"),
    ).resolves.toEqual({
      id: "doc-1",
      folderId: "folder-a",
      title: "Note",
      body: "Body",
      version: 3,
      createdAt: "2026-07-09T01:00:00.000Z",
      updatedAt: "2026-07-09T01:05:00.000Z",
    });
    expect(harness.normalizedCalls()).toEqual([
      "SELECT * FROM folder_get_all()",
      expect.stringContaining("FROM markdown_documents md"),
    ]);
    expect(harness.calls.at(-1)?.values).toEqual(["doc-1"]);
  });

  it("returns null for missing markdown documents and serializes custom views", async () => {
    const harness = createSqlHarness((text, values) => {
      if (text.includes("FROM markdown_documents")) return [];
      if (text.includes("FROM board_custom_views")) {
        expect(values).toEqual(["view-1"]);
        return [
          {
            cv_id: "view-1",
            cv_board_item_id: "custom_view:view-1",
            cv_title: "Progress",
            cv_html: "<p>ready</p>",
            cv_revision: "4",
            cv_archived: false,
            cv_created_actor_kind: "agent",
            cv_created_session_id: "sess-create",
            cv_created_event_id: "7",
            cv_updated_actor_kind: "agent",
            cv_updated_session_id: "sess-update",
            cv_updated_event_id: "9",
            cv_created_at: new Date("2026-07-09T02:00:00.000Z"),
            cv_updated_at: new Date("2026-07-09T02:05:00.000Z"),
            bi_id: "custom_view:view-1",
            bi_folder_id: "folder-a",
            bi_membership_kind: "primary",
            bi_item_type: "custom_view",
            bi_item_id: "view-1",
            bi_x: 0,
            bi_y: 0,
            bi_metadata: {},
            bi_created_at: new Date("2026-07-09T02:00:00.000Z"),
            bi_updated_at: new Date("2026-07-09T02:05:00.000Z"),
          },
        ];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.markdownDocumentRouteProvider.getMarkdownDocument("missing"),
    ).resolves.toBeNull();
    await expect(
      repository.markdownDocumentRouteProvider.getCustomView("view-1"),
    ).resolves.toEqual({
      id: "view-1",
      boardItemId: "custom_view:view-1",
      folderId: "folder-a",
      title: "Progress",
      html: "<p>ready</p>",
      revision: 4,
      archived: false,
      createdAt: "2026-07-09T02:00:00.000Z",
      updatedAt: "2026-07-09T02:05:00.000Z",
    });
    expect(harness.normalizedCalls().at(-1)).toContain(
      "cv.created_actor_kind AS cv_created_actor_kind",
    );
    expect(harness.normalizedCalls().at(-1)).toContain(
      "JOIN board_items bi ON bi.id = cv.board_item_id",
    );
  });


});

function folderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "folder-a",
    name: "Folder",
    sort_order: 1,
    parent_folder_id: null,
    settings: {},
    created_at: new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

function createSqlHarness(
  rowsFor: (text: string, values: unknown[]) => readonly Record<string, unknown>[] = () => [],
) {
  const calls: SqlCall[] = [];
  const sqlCall = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return rowsFor(text, values);
  });
  const sql = Object.assign(sqlCall, {
    json: (value: unknown) => value,
    array: (values: readonly unknown[]) => values,
    begin: async <T>(callback: (transaction: LivePostgresSql) => Promise<T>) =>
      await callback(sqlCall as unknown as LivePostgresSql),
  }) as unknown as LivePostgresSql;

  return {
    sql,
    calls,
    normalizedCalls: () =>
      calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
  };
}
