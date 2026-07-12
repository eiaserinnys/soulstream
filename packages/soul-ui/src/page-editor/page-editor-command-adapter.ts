import {
  planEditorOperation,
  type BlockReference,
  type EditorBlockSnapshot,
  type EditorOperation,
  type EditorOperationPlan,
  type FocusResult,
  type SemanticEditIntent,
} from "@soulstream/page-editor-core";
import * as Y from "yjs";

import type {
  PageApiClient,
  PageStructureOperation,
} from "../page/page-api";

export interface ResolvedEditorFocus {
  readonly blockId: string;
  readonly anchor: number;
  readonly focus: number;
}

export interface PageEditorOperationResult {
  readonly focus: ResolvedEditorFocus | null;
  readonly mutationVersion: number;
  readonly operationId: string;
}

export interface ExecutePageEditorPlanInput {
  readonly apiClient: PageApiClient;
  readonly pageId: string;
  readonly doc: Y.Doc;
  readonly mutationVersion: number;
  readonly plan: EditorOperationPlan;
  readonly idempotencyKey: string;
}

export interface ExecutePageEditorOperationInput
  extends Omit<ExecutePageEditorPlanInput, "plan"> {
  readonly blocks: readonly EditorBlockSnapshot[];
  readonly operation: EditorOperation;
}

export async function executePageEditorOperation(
  input: ExecutePageEditorOperationInput,
): Promise<PageEditorOperationResult> {
  return executePageEditorPlan({
    ...input,
    plan: planEditorOperation(input.blocks, input.operation),
  });
}

export async function executePageEditorPlan(
  input: ExecutePageEditorPlanInput,
): Promise<PageEditorOperationResult> {
  const operations = mapEditorPlanToPageOperations(input.plan);
  if (operations.length === 0) {
    return {
      focus: resolveFocus(input.plan.focus, {}),
      mutationVersion: input.mutationVersion,
      operationId: "noop",
    };
  }
  const response = await input.apiClient.applyOperations(input.pageId, {
    expectedVersion: input.mutationVersion,
    expectedStateVector: Y.encodeStateVector(input.doc),
    idempotencyKey: input.idempotencyKey,
    operations,
  });
  if (!response.idempotent && response.page.version !== input.mutationVersion + 1) {
    throw new Error(
      `page editor mutation version mismatch: expected ${input.mutationVersion + 1}, received ${response.page.version}`,
    );
  }
  return {
    focus: resolveFocus(input.plan.focus, response.temp_id_mapping),
    mutationVersion: response.page.version,
    operationId: response.operation.id,
  };
}

export function mapEditorPlanToPageOperations(
  plan: EditorOperationPlan,
): PageStructureOperation[] {
  return plan.intents.map(mapIntent);
}

function mapIntent(intent: SemanticEditIntent): PageStructureOperation {
  switch (intent.type) {
    case "update-text":
      return { op: "update_block_text", block_id: existingId(intent.target), text: intent.text };
    case "update-type-and-properties":
      return {
        op: "update_block_type_and_properties",
        block_id: existingId(intent.target),
        block_type: intent.blockType,
        properties: { ...intent.properties },
      };
    case "delete-subtree":
      return { op: "delete_block_subtree", block_id: existingId(intent.target) };
    case "move-block": {
      const parent = referenceFields("parent", intent.parent);
      const after = referenceFields("after", intent.after);
      return {
        op: "move_block",
        block_id: existingId(intent.target),
        parent_id: parent.id,
        ...parent.temp,
        after_block_id: after.id,
        ...after.temp,
      };
    }
    case "create-block": {
      const parent = referenceFields("parent", intent.parent);
      const after = referenceFields("after", intent.after);
      return {
        op: "create_block",
        temp_id: intent.tempId,
        parent_id: parent.id,
        ...parent.temp,
        after_block_id: after.id,
        ...after.temp,
        block_type: intent.blockType,
        text: intent.text,
        properties: { ...intent.properties },
        collapsed: intent.collapsed,
      };
    }
  }
}

function existingId(reference: BlockReference): string {
  if (reference.kind !== "existing") {
    throw new Error(`temporary block cannot be a persisted mutation target: ${reference.tempId}`);
  }
  return reference.blockId;
}

function referenceFields(
  kind: "parent" | "after",
  reference: BlockReference | null,
): { id: string | null; temp: Record<string, string> } {
  if (reference === null) return { id: null, temp: {} };
  if (reference.kind === "existing") return { id: reference.blockId, temp: {} };
  return {
    id: null,
    temp: kind === "parent"
      ? { parent_temp_id: reference.tempId }
      : { after_temp_id: reference.tempId },
  };
}

function resolveFocus(
  focus: FocusResult | null,
  tempIdMapping: Readonly<Record<string, string>>,
): ResolvedEditorFocus | null {
  if (focus === null) return null;
  const blockId = focus.target.kind === "existing"
    ? focus.target.blockId
    : tempIdMapping[focus.target.tempId];
  if (!blockId) throw new Error(`page editor focus target was not resolved: ${focus.target.kind === "temporary" ? focus.target.tempId : focus.target.blockId}`);
  return { blockId, anchor: focus.selection.anchor, focus: focus.selection.focus };
}
