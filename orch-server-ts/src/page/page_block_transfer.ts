import { compareLexicographically, comparePositionKeys } from "@soulstream/fractional-position";
import { parseInlineRefs } from "@soulstream/page-model";

import type { PageBatchOperation } from "./page_mutation_core.js";
import { PageMutationValidationError } from "./page_mutation_validation.js";
import type { PageYjsBlockReplica, PageYjsReplica } from "./page_yjs_model.js";

export interface PageBlockTransferPlanInput {
  source: PageYjsReplica;
  target: PageYjsReplica | null;
  selectedBlockIds: readonly string[];
  targetPlacement: { parentId: string | null; afterBlockId: string | null };
  sourceMount?: { title: string; tempId: string };
}

export interface PageBlockTransferPlan {
  sourceOperations: readonly PageBatchOperation[];
  targetOperations: readonly PageBatchOperation[];
  primarySessionIds: readonly string[];
}

export function planPageBlockTransfer(input: PageBlockTransferPlanInput): PageBlockTransferPlan {
  const sourceIndex = new ReplicaIndex(input.source);
  const selection = sourceIndex.selection(input.selectedBlockIds);
  const samePage = input.target?.page.id === input.source.page.id;
  if (samePage && input.sourceMount) {
    throw new PageMutationValidationError("extract target must be a different page");
  }
  if (input.sourceMount) {
    const mountText = `[[${input.sourceMount.title}]]`;
    const segments = parseInlineRefs(mountText);
    if (
      segments.length !== 1 ||
      segments[0]?.kind !== "pageRef" ||
      segments[0].pageTitle !== input.sourceMount.title
    ) {
      throw new PageMutationValidationError("extract target title cannot be represented as an exact page mount");
    }
    if (input.target && input.target.page.title !== input.sourceMount.title) {
      throw new PageMutationValidationError("extract mount title must match the target page title");
    }
  }

  const movedIds = new Set(selection.blocks.map((block) => block.id));
  if (samePage) {
    if (
      (input.targetPlacement.parentId && movedIds.has(input.targetPlacement.parentId)) ||
      (input.targetPlacement.afterBlockId && movedIds.has(input.targetPlacement.afterBlockId))
    ) {
      throw new PageMutationValidationError("transfer target cannot be inside the moved selection");
    }
    let afterBlockId = input.targetPlacement.afterBlockId;
    return {
      sourceOperations: selection.roots.map((block) => {
        const operation: PageBatchOperation = {
          op: "move_block",
          blockId: block.id,
          parentId: input.targetPlacement.parentId,
          afterBlockId,
        };
        afterBlockId = block.id;
        return operation;
      }),
      targetOperations: [],
      primarySessionIds: primarySessionIds(selection.blocks),
    };
  }

  const targetIds = new Set(input.target?.blocks.map((block) => block.id) ?? []);
  const collision = selection.blocks.find((block) => targetIds.has(block.id));
  if (collision) throw new PageMutationValidationError(`target page already contains block: ${collision.id}`);

  const sourceOperations: PageBatchOperation[] = [];
  if (input.sourceMount) {
    sourceOperations.push({
      op: "create_block",
      tempId: input.sourceMount.tempId,
      parentId: selection.parentId,
      afterBlockId: selection.previousSiblingId,
      blockType: "paragraph",
      text: `[[${input.sourceMount.title}]]`,
      properties: {},
      collapsed: false,
    });
  }
  sourceOperations.push(...selection.roots.map((block) => ({
    op: "delete_block_subtree" as const,
    blockId: block.id,
  })));

  const targetOperations: PageBatchOperation[] = [];
  let rootAfter = input.targetPlacement.afterBlockId;
  for (const root of selection.roots) {
    appendCreateTree({
      block: root,
      index: sourceIndex,
      parentId: input.targetPlacement.parentId,
      afterBlockId: rootAfter,
      operations: targetOperations,
    });
    rootAfter = root.id;
  }
  return {
    sourceOperations,
    targetOperations,
    primarySessionIds: primarySessionIds(selection.blocks),
  };
}

function appendCreateTree(input: {
  block: PageYjsBlockReplica;
  index: ReplicaIndex;
  parentId: string | null;
  afterBlockId: string | null;
  operations: PageBatchOperation[];
}): void {
  input.operations.push({
    op: "create_block",
    id: input.block.id,
    tempId: `transfer-${input.block.id}`,
    parentId: input.parentId,
    afterBlockId: input.afterBlockId,
    blockType: input.block.type,
    text: input.block.text,
    textDelta: structuredClone(input.block.textDelta),
    properties: structuredClone(input.block.properties),
    collapsed: input.block.collapsed,
  });
  let childAfter: string | null = null;
  for (const child of input.index.children(input.block.id)) {
    appendCreateTree({
      block: child,
      index: input.index,
      parentId: input.block.id,
      afterBlockId: childAfter,
      operations: input.operations,
    });
    childAfter = child.id;
  }
}

class ReplicaIndex {
  private readonly byId: ReadonlyMap<string, PageYjsBlockReplica>;
  private readonly byParent = new Map<string | null, PageYjsBlockReplica[]>();

  constructor(replica: PageYjsReplica) {
    this.byId = new Map(replica.blocks.map((block) => [block.id, block]));
    for (const block of replica.blocks) {
      const siblings = this.byParent.get(block.parentId) ?? [];
      siblings.push(block);
      this.byParent.set(block.parentId, siblings);
    }
    for (const siblings of this.byParent.values()) siblings.sort(compareBlocks);
  }

  children(parentId: string | null): readonly PageYjsBlockReplica[] {
    return this.byParent.get(parentId) ?? [];
  }

  selection(selectedBlockIds: readonly string[]) {
    if (selectedBlockIds.length === 0) {
      throw new PageMutationValidationError("block transfer selection must not be empty");
    }
    if (new Set(selectedBlockIds).size !== selectedBlockIds.length) {
      throw new PageMutationValidationError("block transfer selection must not contain duplicates");
    }
    const selected = new Set(selectedBlockIds);
    const requested = selectedBlockIds.map((blockId) => {
      const block = this.byId.get(blockId);
      if (!block) throw new PageMutationValidationError(`block not found in source page: ${blockId}`);
      return block;
    });
    const flat = this.children(null).flatMap((block) => this.flatten(block));
    const flatIndex = new Map(flat.map((block, index) => [block.id, index]));
    const roots = requested.filter((block) => !this.hasSelectedAncestor(block, selected))
      .sort((left, right) => flatIndex.get(left.id)! - flatIndex.get(right.id)!);
    const blocks = roots.flatMap((root) => this.flatten(root));
    const movedIds = new Set(blocks.map((block) => block.id));
    const indexes = blocks.map((block) => flatIndex.get(block.id)!).sort((left, right) => left - right);
    const interval = flat.slice(indexes[0]!, indexes.at(-1)! + 1);
    if (interval.length !== movedIds.size || interval.some((block) => !movedIds.has(block.id))) {
      throw new PageMutationValidationError("selected transfer roots must form one contiguous outline range");
    }
    const first = roots[0]!;
    const siblings = this.children(first.parentId);
    const firstSiblingIndex = siblings.findIndex((candidate) => candidate.id === first.id);
    return {
      roots,
      blocks,
      parentId: first.parentId,
      previousSiblingId: siblings[firstSiblingIndex - 1]?.id ?? null,
    };
  }

  private hasSelectedAncestor(block: PageYjsBlockReplica, selected: ReadonlySet<string>): boolean {
    let parentId = block.parentId;
    while (parentId !== null) {
      if (selected.has(parentId)) return true;
      parentId = this.byId.get(parentId)?.parentId ?? null;
    }
    return false;
  }

  private flatten(root: PageYjsBlockReplica): PageYjsBlockReplica[] {
    return [root, ...this.children(root.id).flatMap((child) => this.flatten(child))];
  }
}

function compareBlocks(left: PageYjsBlockReplica, right: PageYjsBlockReplica): number {
  return comparePositionKeys(left.positionKey, right.positionKey) || compareLexicographically(left.id, right.id);
}

function primarySessionIds(blocks: readonly PageYjsBlockReplica[]): string[] {
  return blocks.flatMap((block) => (
    block.type === "session_ref" && block.properties.primary === true && typeof block.properties.sessionId === "string"
      ? [block.properties.sessionId]
      : []
  ));
}
