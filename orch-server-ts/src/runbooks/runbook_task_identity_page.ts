import { markdownToPageBlocks } from "@soulstream/page-model";
import * as Y from "yjs";

import {
  PageMutationCore,
  type PageMutationActor,
} from "../page/page_mutation_core.js";
import { readPageYDocReplica } from "../page/page_yjs_model.js";

export function initialTaskOperations(
  title: string,
  description: string,
  runbookId: string,
  createId: () => string,
) {
  const source = description.trim() ? `# ${title}\n\n${description.trim()}` : `# ${title}`;
  const blocks = markdownToPageBlocks(source, { title, createId });
  const lastSibling = new Map<string | null, string>();
  const operations = blocks.map((block) => {
    const previous = lastSibling.get(block.parent_id) ?? null;
    lastSibling.set(block.parent_id, block.id);
    return {
      op: "create_block" as const,
      tempId: block.id,
      parentId: null,
      ...(block.parent_id ? { parentTempId: block.parent_id } : {}),
      afterBlockId: null,
      ...(previous ? { afterTempId: previous } : {}),
      blockType: block.type,
      text: block.text,
      properties: block.properties,
      collapsed: block.collapsed,
    };
  });
  const lastRoot = lastSibling.get(null) ?? null;
  operations.push({
    op: "create_block" as const,
    tempId: createId(),
    parentId: null,
    afterBlockId: null,
    ...(lastRoot ? { afterTempId: lastRoot } : {}),
    blockType: "runbook_ref",
    text: "",
    properties: { runbookId, primary: true },
    collapsed: false,
  });
  return operations;
}

export async function loadPageDocument(
  pageId: string,
  readSnapshot: (pageId: string) => Promise<Uint8Array | null>,
): Promise<Y.Doc> {
  const encoded = await readSnapshot(pageId);
  if (!encoded) throw new Error(`task identity page snapshot missing: ${pageId}`);
  const document = new Y.Doc();
  Y.applyUpdate(document, encoded);
  readPageYDocReplica(pageId, document);
  return document;
}

export function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must be a non-empty string`);
  return trimmed;
}

export function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("new task identity id must be a UUID");
  }
}

export function pageIdempotencyKey(actor: PageMutationActor, requestKey: string): string {
  return pageMutationIdempotencyKey("create_task_identity", actor, `${requestKey}:page`);
}

export function pageMutationIdempotencyKey(
  operation: string,
  actor: PageMutationActor,
  requestKey: string,
): string {
  const caller = actor.actorSessionId ?? actor.actorUserId ?? actor.actorKind;
  return `${operation}:${caller}:${requestKey}`;
}

export function isIdentityPageCommand(
  command: Parameters<PageMutationCore["mutate"]>[1]["command"],
): boolean {
  if (
    command.type === "rename_page"
    || command.type === "archive_page"
    || command.type === "unarchive_page"
  ) {
    return true;
  }
  return command.type === "batch_operations" && command.operations.some((operation) =>
    operation.op === "rename_page" || operation.op === "set_page_archived"
  );
}
