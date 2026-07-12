import { planMergeNext, planMergePrevious, planSplit } from "./enter-merge-operations.js";
import { planPaste, planPasteOverSelection } from "./paste-operations.js";
import { SnapshotIndex } from "./snapshot.js";
import { planDeleteSelection, planIndent, planOutdent } from "./tree-operations.js";
import { noopPlan, type EditorBlockSnapshot, type EditorOperation, type EditorOperationPlan } from "./types.js";

export function planEditorOperation(
  snapshot: readonly EditorBlockSnapshot[],
  operation: EditorOperation,
): EditorOperationPlan {
  if (operation.type === "noop") return noopPlan(operation.reason);
  const index = new SnapshotIndex(snapshot);
  assertTargetsExist(index, operation);
  let plan: EditorOperationPlan;
  switch (operation.type) {
    case "splitBlock":
      plan = planSplit(index, operation.blockId, operation.selection, operation.newBlockTempId, operation.isComposing);
      break;
    case "mergePrevious":
      plan = planMergePrevious(index, operation.blockId, operation.selection, operation.isComposing);
      break;
    case "mergeNext":
      plan = planMergeNext(index, operation.blockId, operation.selection, operation.isComposing);
      break;
    case "indent":
      plan = planIndent(index, operation.blockIds, operation.focus);
      break;
    case "outdent":
      plan = planOutdent(index, operation.blockIds, operation.focus);
      break;
    case "deleteSelection":
      plan = planDeleteSelection(index, operation.blockIds);
      break;
    case "paste":
      plan = planPaste(index, operation.blockId, operation.selection, operation.payload, operation.tempIdPrefix);
      break;
    case "pasteOverSelection":
      plan = planPasteOverSelection(
        index,
        operation.blockIds,
        operation.placeholderTempId,
        operation.payload,
        operation.tempIdPrefix,
      );
      break;
  }
  if (plan.noopReason === "invalid-group" && targetIds(operation).length > 0) {
    throw new EditorOperationUnavailableError("The selected blocks can no longer be edited together.");
  }
  if (plan.noopReason === "files-or-media" || plan.noopReason === "empty-clipboard") {
    throw new EditorOperationUnavailableError("The clipboard content cannot be pasted here.");
  }
  return plan;
}

export class StaleEditorTargetError extends Error {
  constructor(readonly blockId: string) {
    super(`Editor target is stale: ${blockId}`);
    this.name = "StaleEditorTargetError";
  }
}

export class EditorOperationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorOperationUnavailableError";
  }
}

function assertTargetsExist(index: SnapshotIndex, operation: EditorOperation): void {
  for (const blockId of targetIds(operation)) {
    if (!index.byId.has(blockId)) throw new StaleEditorTargetError(blockId);
  }
}

function targetIds(operation: EditorOperation): readonly string[] {
  switch (operation.type) {
    case "splitBlock":
    case "mergePrevious":
    case "mergeNext":
    case "paste":
      return [operation.blockId];
    case "indent":
    case "outdent":
      return operation.focus
        ? [...operation.blockIds, operation.focus.blockId]
        : operation.blockIds;
    case "deleteSelection":
    case "pasteOverSelection":
      return operation.blockIds;
    case "noop":
      return [];
  }
}
