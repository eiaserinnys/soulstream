import {
  markdownToPageBlocks,
  type InitialFolderContext,
} from "@soulstream/page-model";
import * as Y from "yjs";

import {
  PageMutationCore,
  type PageMutationActor,
} from "../page/page_mutation_core.js";
import { readPageYDocReplica } from "../page/page_yjs_model.js";

export function initialFolderOperations(
  title: string,
  description: string,
  folderId: string,
  createId: () => string,
  initialContext?: InitialFolderContext,
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
  const contextOperations = initialFolderContextOperations({
    context: initialContext,
    createId,
    afterTempId: lastSibling.get(null) ?? null,
  });
  const operations = [...contentOperations, ...contextOperations];
  return operations;
}

export function initialFolderContextOperations({
  context,
  createId,
  afterBlockId = null,
  afterTempId = null,
}: {
  context?: InitialFolderContext;
  createId(): string;
  afterBlockId?: string | null;
  afterTempId?: string | null;
}) {
  if (!context) return [];
  const specifications = [
    ...(context.guidance.trim() ? [{
      blockType: "guidance" as const,
      text: context.guidance.trim(),
      properties: { enabled: true, scope: "folder" },
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
        ...(reference.limit !== undefined ? { limit: reference.limit } : {}),
      },
    })),
    ...(context.sessionDefaults ? [{
      blockType: "session_defaults" as const,
      text: "",
      properties: {
        agentId: context.sessionDefaults.agentId,
        nodeId: context.sessionDefaults.nodeId,
        ...(context.sessionDefaults.modelPreset
          ? { modelPreset: context.sessionDefaults.modelPreset }
          : {}),
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

