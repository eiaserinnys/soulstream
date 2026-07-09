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
            id: "view-1",
            board_item_id: "custom_view:view-1",
            folder_id: "folder-a",
            title: "Progress",
            html: "<p>ready</p>",
            revision: "4",
            archived: false,
            created_session_id: "sess-create",
            created_event_id: "7",
            updated_session_id: "sess-update",
            updated_event_id: "9",
            created_at: new Date("2026-07-09T02:00:00.000Z"),
            updated_at: new Date("2026-07-09T02:05:00.000Z"),
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
  });

  it("uses the board item provider semantics for runbook container folders", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("board_item_get_all")) {
        return [
          {
            ...boardItemRow(),
            id: "runbook-card",
            folder_id: "folder-a",
            item_type: "runbook",
            item_id: "runbook-1",
          },
        ];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.markdownDocumentRouteProvider.resolveBoardContainerFolderId({
        kind: "folder",
        id: "folder-direct",
      }),
    ).resolves.toBe("folder-direct");
    await expect(
      repository.markdownDocumentRouteProvider.resolveBoardContainerFolderId({
        kind: "runbook",
        id: "runbook-1",
      }),
    ).resolves.toBe("folder-a");
    await expect(
      repository.markdownDocumentRouteProvider.resolveBoardContainerFolderId({
        kind: "runbook",
        id: "missing",
      }),
    ).rejects.toMatchObject(
      new MarkdownDocumentRouteError(
        "BOARD_CONTAINER_NOT_FOUND",
        "Runbook board container not found",
        404,
      ),
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

function boardItemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "item-a",
    folder_id: "folder-a",
    container_kind: "folder",
    container_id: "folder-a",
    membership_kind: "primary",
    source_runbook_item_id: null,
    item_type: "session",
    item_id: "sess-1",
    x: 20,
    y: 40,
    metadata: {},
    created_at: new Date("2026-07-09T00:00:00.000Z"),
    updated_at: new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

function createSqlHarness(
  rowsFor: (text: string, values: unknown[]) => readonly Record<string, unknown>[] = () => [],
) {
  const calls: SqlCall[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return rowsFor(text, values);
  }) as unknown as LivePostgresSql;

  return {
    sql,
    calls,
    normalizedCalls: () =>
      calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
  };
}
