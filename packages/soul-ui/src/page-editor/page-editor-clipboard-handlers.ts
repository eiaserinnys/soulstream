import type { EditorOperation } from "@soulstream/page-editor-core";
import type React from "react";
import * as Y from "yjs";

import type { PageDocumentBlock } from "../page";
import type { PageBlockEditorKeyInput } from "./PageBlockEditor";
import {
  encodeClipboardStateVector,
  readPageEditorClipboardEnvelope,
  writeBlockSelectionClipboard,
} from "./page-editor-clipboard";
import type { ContiguousBlockSelection } from "./page-editor-selection";
import { uniqueTempId } from "./page-outliner-operations";
import { toEditorSnapshots } from "./usePageEditorController";

export function createPageEditorClipboardHandlers(input: {
  pageId: string;
  doc: Y.Doc;
  blocks: readonly PageDocumentBlock[];
  mutationVersion: number;
  selectionMode: boolean;
  selection: ContiguousBlockSelection;
  run(operation: EditorOperation): Promise<void>;
  reportFailure(message: string): void;
  pasteCut(cut: NonNullable<ReturnType<typeof readPageEditorClipboardEnvelope>["cut"]>, target: PageDocumentBlock): Promise<boolean>;
  clearSelection(): void;
}) {
  const pasteInput = (
    keyInput: PageBlockEditorKeyInput,
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ) => {
    if (keyInput.isComposing) return;
    const selectedIds = input.selection.getSnapshot().blockIds;
    event.preventDefault();
    let clipboard;
    try {
      clipboard = readPageEditorClipboardEnvelope(event.clipboardData);
    } catch {
      input.reportFailure("The clipboard data could not be read. Nothing was changed.");
      return;
    }
    if (clipboard.cut) {
      void input.pasteCut(clipboard.cut, keyInput.block).then((moved) => {
        if (moved) input.clearSelection();
      });
      return;
    }
    const operation: EditorOperation = selectedIds.length > 1
      ? {
          type: "pasteOverSelection",
          blockIds: selectedIds,
          placeholderTempId: uniqueTempId("paste-selection"),
          payload: clipboard.payload,
          tempIdPrefix: uniqueTempId("paste-tree"),
        }
      : {
          type: "paste",
          blockId: keyInput.block.id,
          selection: { anchor: keyInput.anchor, focus: keyInput.focus },
          payload: clipboard.payload,
          tempIdPrefix: uniqueTempId("paste-tree"),
        };
    void input.run(operation);
  };

  const copyOrCutSelection = (event: React.ClipboardEvent<HTMLElement>, cut: boolean) => {
    const selectedIds = input.selection.getSnapshot().blockIds;
    if (selectedIds.length === 0 || (selectedIds.length === 1 && !input.selectionMode)) return;
    event.preventDefault();
    const wrote = writeBlockSelectionClipboard(
      event.clipboardData,
      toEditorSnapshots(input.pageId, input.blocks),
      selectedIds,
      cut ? {
        sourcePageId: input.pageId,
        blockIds: selectedIds,
        expectedVersion: input.mutationVersion,
        expectedStateVector: encodeClipboardStateVector(Y.encodeStateVector(input.doc)),
        idempotencyKey: `page-cut:${input.pageId}:${crypto.randomUUID()}`,
      } : undefined,
    );
    if (!wrote) {
      input.reportFailure("The clipboard could not be written. The selected blocks were not changed.");
    }
  };

  return {
    pasteInput,
    copyOrCutSelection,
    copyInput: (_input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>) => (
      copyOrCutSelection(event, false)
    ),
    cutInput: (_input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>) => (
      copyOrCutSelection(event, true)
    ),
  };
}
