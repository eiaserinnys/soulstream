import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { MarkdownDocumentService } from "../src/board/markdown_document_service.js";
import { FolderContentRepository } from "../src/board/folder_content_repository.js";
import { FlatFolderContentHost } from "../src/board/flat_folder_content_host.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";

describe("flat markdown movement", () => {
  let harness: FullSchemaPostgresHarness;
  beforeAll(async () => { harness = await createFullSchemaPostgresHarness(); }, 60_000);
  afterAll(async () => { await harness?.cleanup(); });

  it("moves a virtual markdown item, creates its primary row and removes a destination reference", async () => {
    await harness.sql`INSERT INTO folders (id, name) VALUES ('move-src', 'Source'), ('move-dst', 'Target')`;
    await harness.sql`INSERT INTO markdown_documents (id, folder_id, title, body) VALUES ('move-doc', 'move-src', 'Title', 'Body')`;
    await harness.sql`INSERT INTO board_items (id, folder_id, membership_kind, item_type, item_id)
      VALUES ('ref-dst', 'move-dst', 'reference', 'markdown', 'move-doc')`;
    const resolver = { resolveSql: async () => harness.sql as unknown as LivePostgresSql, close: async () => {} };
    const notify = vi.fn(async () => {});
    const service = new MarkdownDocumentService(resolver, notify);
    const reads = new FolderContentRepository(resolver);
    const host = new FlatFolderContentHost(resolver, service, {} as never, async () => {}, async () => {});
    expect(await reads.getBoardItemById('markdown:move-doc')).toMatchObject({ itemId: 'move-doc', folderId: 'move-dst', membershipKind: 'primary' });
    await host.moveBoardItem('markdown:move-doc', 'move-src', 'move-1');
    expect(await harness.sql`SELECT id, folder_id, membership_kind FROM board_items WHERE item_id = 'move-doc' ORDER BY id`)
      .toEqual([{ id: 'markdown:move-doc', folder_id: 'move-src', membership_kind: 'primary' }, { id: 'ref-dst', folder_id: 'move-dst', membership_kind: 'reference' }]);
    await host.moveBoardItem('markdown:move-doc', 'move-dst', 'move-2');
    expect(await harness.sql`SELECT id, folder_id, membership_kind FROM board_items WHERE item_id = 'move-doc'`)
      .toEqual([{ id: 'markdown:move-doc', folder_id: 'move-dst', membership_kind: 'primary' }]);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ deletedBoardItemIds: ['ref-dst'] }));
  });

  it("paginates documents with timestamps in the same millisecond without skipping any", async () => {
    await harness.sql`INSERT INTO folders (id, name) VALUES ('page-folder', 'Page')`;
    await harness.sql`INSERT INTO markdown_documents (id, folder_id, title, updated_at)
      VALUES ('page-a', 'page-folder', 'A', '2026-01-01 00:00:00.000900+00'),
             ('page-b', 'page-folder', 'B', '2026-01-01 00:00:00.000800+00'),
             ('page-c', 'page-folder', 'C', '2026-01-01 00:00:00.000700+00')`;
    const resolver = { resolveSql: async () => harness.sql as unknown as LivePostgresSql, close: async () => {} };
    const reads = new FolderContentRepository(resolver);
    const first = await reads.listMarkdownDocuments({ folderId: 'page-folder', limit: 1 });
    const second = await reads.listMarkdownDocuments({ folderId: 'page-folder', limit: 1, cursor: first.nextCursor! });
    const third = await reads.listMarkdownDocuments({ folderId: 'page-folder', limit: 1, cursor: second.nextCursor! });
    expect([first, second, third].map(page => page.documents[0]?.id)).toEqual(['page-a', 'page-b', 'page-c']);
    expect(third.nextCursor).toBeNull();
  });
});
