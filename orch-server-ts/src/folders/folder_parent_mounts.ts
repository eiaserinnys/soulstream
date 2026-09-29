import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { BoardYjsQuerySql } from "../board-yjs/board_yjs_sql.js";
import { PageMutationCore, type PageMutationActor, type PageBatchOperation } from "../page/page_mutation_core.js";
import { assertDatabaseMutationVersion, commitPageMutationInTransaction } from "../page/page_repository.js";
import { readPageYDocReplica } from "../page/page_yjs_model.js";
import type { PageUpdatedNotification } from "../page/page_update_notifications.js";

/** Called only by the folder identity transaction and the one-time migration. */
export async function reconcileFolderParentMounts(sql: BoardYjsQuerySql, input: {
  pageId: string; title: string; previousParentFolderId: string | null;
  parentFolderId: string | null; actor: PageMutationActor; idempotencyKey: string;
}): Promise<{ updates: PageUpdatedNotification[]; added: number }> {
  const updates: PageUpdatedNotification[] = [];
  let added = 0;
  const parents = [...new Set([input.previousParentFolderId, input.parentFolderId])]
    .filter((id): id is string => id !== null).sort();
  for (const folderId of parents) {
    const rows = await sql<readonly { page_id: string; snapshot: Uint8Array }[]>`
      SELECT f.project_page_id AS page_id, d.snapshot
      FROM folders f JOIN board_yjs_documents d ON d.name = 'page:' || f.project_page_id
      WHERE f.id = ${folderId} FOR UPDATE OF f, d
    `;
    const parent = rows[0];
    if (!parent) throw new Error(`Parent folder page snapshot missing: ${folderId}`);
    const mounts = await sql<readonly { source_block_id: string }[]>`
      SELECT l.source_block_id FROM block_links l JOIN blocks b ON b.id = l.source_block_id
      WHERE b.page_id = ${parent.page_id} AND l.link_kind = 'mount' AND l.target_page_id = ${input.pageId}
    `;
    const target = folderId === input.parentFolderId;
    if (target && mounts.length > 0 || !target && mounts.length === 0) continue;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, parent.snapshot);
      const replica = readPageYDocReplica(parent.page_id, doc);
      const operations: PageBatchOperation[] = [];
      if (target) {
        const text = `[[${input.title}]]`;
        operations.push({ op: "create_block", tempId: "folder-mount", id: randomUUID(), parentId: null,
          afterBlockId: replica.blocks.filter(block => block.parentId === null).at(-1)?.id ?? null,
          blockType: "paragraph", text,
          textDelta: [{ insert: text, attributes: { ref: { kind: "page", targetId: input.pageId } } }],
          properties: {} });
        added += 1;
      } else {
        for (const mount of mounts) {
          const block = replica.blocks.find(block => block.id === mount.source_block_id);
          if (!block) throw new Error(`Parent mount missing from snapshot: ${mount.source_block_id}`);
          // Keep any user-authored children when removing the structural mount.
          let afterBlockId = block.id;
          for (const child of replica.blocks.filter(child => child.parentId === block.id)) {
            operations.push({ op: "move_block", blockId: child.id, parentId: block.parentId, afterBlockId });
            afterBlockId = child.id;
          }
          operations.push({ op: "delete_block_subtree", blockId: block.id });
        }
      }
      const application = new PageMutationCore().mutate(doc, {
        pageId: parent.page_id, expectedVersion: replica.page.mutationVersion,
        command: { type: "batch_operations", operations }, actor: input.actor,
        idempotencyKey: `folder-mount:${input.idempotencyKey}:${parent.page_id}`,
        reason: "align child folder mount with folder parent",
      });
      const commit = { documentName: `page:${parent.page_id}`, application, operationId: randomUUID() };
      await assertDatabaseMutationVersion(sql, commit);
      await commitPageMutationInTransaction(sql, commit);
      updates.push({ pageId: parent.page_id, version: application.resultVersion });
    } finally { doc.destroy(); }
  }
  return { updates, added };
}

export async function backfillFolderParentMounts(sql: BoardYjsQuerySql): Promise<number> {
  const missing = await sql<readonly { id: string; name: string; page_id: string; parent_folder_id: string }[]>`
    SELECT f.id, f.name, f.project_page_id AS page_id, f.parent_folder_id
    FROM folders f JOIN folders p ON p.id = f.parent_folder_id
    WHERE f.project_page_id IS NOT NULL AND p.project_page_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM block_links l JOIN blocks b ON b.id = l.source_block_id
        WHERE b.page_id = p.project_page_id AND l.link_kind = 'mount' AND l.target_page_id = f.project_page_id
      )
    ORDER BY f.id
  `;
  let added = 0;
  for (const folder of missing) {
    const result = await reconcileFolderParentMounts(sql, {
      pageId: folder.page_id, title: folder.name, previousParentFolderId: null,
      parentFolderId: folder.parent_folder_id, actor: { actorKind: "system" },
      idempotencyKey: `migration108:${folder.id}`,
    });
    added += result.added;
  }
  return added;
}
