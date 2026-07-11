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
  switch (operation.type) {
    case "splitBlock":
      return planSplit(index, operation.blockId, operation.selection, operation.newBlockTempId, operation.isComposing);
    case "mergePrevious":
      return planMergePrevious(index, operation.blockId, operation.selection, operation.isComposing);
    case "mergeNext":
      return planMergeNext(index, operation.blockId, operation.selection, operation.isComposing);
    case "indent":
      return planIndent(index, operation.blockIds);
    case "outdent":
      return planOutdent(index, operation.blockIds);
    case "deleteSelection":
      return planDeleteSelection(index, operation.blockIds);
    case "paste":
      return planPaste(index, operation.blockId, operation.selection, operation.payload, operation.tempIdPrefix);
    case "pasteOverSelection":
      return planPasteOverSelection(
        index,
        operation.blockIds,
        operation.placeholderTempId,
        operation.payload,
        operation.tempIdPrefix,
      );
  }
}
