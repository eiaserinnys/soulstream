import {
  markdownToPageBlocks,
  type InitialTaskContext,
} from "@soulstream/page-model";
import * as Y from "yjs";

import {
  PageMutationCore,
  type PageMutationActor,
} from "../page/page_mutation_core.js";
import { readPageYDocReplica } from "../page/page_yjs_model.js";

export function initialTaskOperations(
  title: string,
  description: string,
  taskId: string,
  createId: () => string,
  initialContext?: InitialTaskContext,
) {
  const source = description.trim() ? `# ${title}\n\n${description.trim()}` : `# ${title}`;
  const blocks = markdownToPageBlocks(source, { title, createId });
  const lastSibling = new Map<string | null, string>();
  const contentOperations = blocks.map((block) => {
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
  const contextOperations = initialTaskContextOperations({
    context: initialContext,
    createId,
    afterTempId: lastSibling.get(null) ?? null,
  });
  const operations = [...contentOperations, ...contextOperations];
  const lastRoot = contextOperations.at(-1)?.tempId ?? lastSibling.get(null) ?? null;
  operations.push({
    op: "create_block" as const,
    tempId: createId(),
    parentId: null,
    afterBlockId: null,
    ...(lastRoot ? { afterTempId: lastRoot } : {}),
    blockType: "task_ref",
    text: "",
    properties: { taskId, primary: true },
    collapsed: false,
  });
  return operations;
}

export function initialTaskContextOperations({
  context,
  createId,
  afterBlockId = null,
  afterTempId = null,
}: {
  context?: InitialTaskContext;
  createId(): string;
  afterBlockId?: string | null;
  afterTempId?: string | null;
}) {
  if (!context) return [];
  const specifications = [
    ...(context.guidance.trim() ? [{
      blockType: "guidance" as const,
      text: context.guidance.trim(),
      properties: { enabled: true, scope: "task" },
    }] : []),
    ...context.atomReferences.map((reference) => ({
      blockType: "atom_ref" as const,
      text: "",
      properties: {
        instance: reference.instance,
        nodeId: reference.nodeId,
        nodeTitle: reference.nodeTitle,
        depth: reference.depth,
        titlesOnly: reference.titlesOnly,
      },
    })),
    ...(context.sessionDefaults ? [{
      blockType: "session_defaults" as const,
      text: "",
      properties: {
        agentId: context.sessionDefaults.agentId,
        nodeId: context.sessionDefaults.nodeId,
        scope: "session" as const,
      },
    }] : []),
  ];
  let previousTempId = afterTempId;
  return specifications.map((specification, index) => {
    const tempId = createId();
    const operation = {
      op: "create_block" as const,
      tempId,
      parentId: null,
      afterBlockId: index === 0 && !previousTempId ? afterBlockId : null,
      ...(previousTempId ? { afterTempId: previousTempId } : {}),
      ...specification,
      collapsed: false,
    };
    previousTempId = tempId;
    return operation;
  });
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
