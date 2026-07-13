import {
  createPostRenderFocusSelectionApplier,
  type EditorOperation,
} from "@soulstream/page-editor-core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type * as Y from "yjs";

import type {
  PageApiClient,
  PageDocumentBlock,
  PageLens,
  SessionSummaryIndex,
} from "../page";
import type { SessionSummary } from "../shared/types";
import { PageBlockRow } from "./PageBlockRow";
import type { PageBlockEditorKeyInput } from "./PageBlockEditor";
import { PageEditorFeedback, PageEditorMutationStatus } from "./PageEditorNotices";
import { readPageEditorClipboard, writeBlockSelectionClipboard } from "./page-editor-clipboard";
import { createContiguousBlockSelection } from "./page-editor-selection";
import {
  PAGE_EDITOR_LAYOUT_SPACING,
  pageEditorSelectionSegment,
} from "./page-editor-visual-tokens";
import {
  crossesVerticalBlockEdge,
  cssEscape,
  handleArrowNavigation,
  outlineDepths,
  structuralOperation,
  toCoreFocus,
  uniqueTempId,
  visibleOutlineBlocks,
} from "./page-outliner-operations";
import { toEditorSnapshots, usePageEditorController } from "./usePageEditorController";

const ROW_HEIGHT = PAGE_EDITOR_LAYOUT_SPACING.rowMinHeightPx;
const EMPTY_SESSION_INDEX: SessionSummaryIndex = new Map();

export function PageOutliner({
  pageId,
  doc,
  blocks,
  mutationVersion,
  apiClient,
  onResync,
  sessionIndex = EMPTY_SESSION_INDEX,
  lens = "default",
  onOpenSession,
  onCreateSessionDraft,
  onOpenPage,
  onOpenBlock,
  focusBlockId = null,
}: {
  pageId: string;
  doc: Y.Doc;
  blocks: readonly PageDocumentBlock[];
  mutationVersion: number;
  apiClient: PageApiClient;
  onResync(): void;
  sessionIndex?: SessionSummaryIndex;
  lens?: PageLens;
  onOpenSession?(session: SessionSummary): void;
  onCreateSessionDraft?(anchor: { pageId: string; blockId: string; expectedVersion: number }): void;
  onOpenPage?(pageId: string): void;
  onOpenBlock?(pageId: string, blockId: string): void;
  focusBlockId?: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const renderedBlocks = useMemo(() => visibleOutlineBlocks(blocks), [blocks]);
  const [, renderSelection] = useReducer((value) => value + 1, 0);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectionFocusId, setSelectionFocusId] = useState<string | null>(null);
  const [armedAtomicDeleteId, setArmedAtomicDeleteId] = useState<string | null>(null);
  const lastTextSelections = useRef(new Map<string, { anchor: number; focus: number }>());
  const selection = useMemo(
    () => createContiguousBlockSelection(renderedBlocks.map((block) => block.id)),
    [pageId],
  );
  selection.replaceBlockOrder(renderedBlocks.map((block) => block.id));
  const selectionSnapshot = selection.getSnapshot();
  const selected = new Set(selectionMode ? selectionSnapshot.blockIds : []);
  const depths = useMemo(() => outlineDepths(renderedBlocks), [renderedBlocks]);
  const editor = usePageEditorController({ apiClient, pageId, doc, blocks, mutationVersion, onResync });
  const virtualizer = useVirtualizer({
    count: renderedBlocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => renderedBlocks[index]?.id ?? index,
    initialRect: { width: 800, height: 600 },
  });
  const remeasureEditorRow = useCallback((blockId: string) => {
    const row = rowElements.current.get(blockId);
    if (row) virtualizer.measureElement(row);
  }, [virtualizer]);
  const focusApplier = useMemo(() => createPostRenderFocusSelectionApplier({
    getTextControlByBlockId(blockId) {
      return scrollRef.current?.querySelector<HTMLTextAreaElement>(
        `[data-page-block-editor="${cssEscape(blockId)}"]`,
      ) ?? null;
    },
  }), []);

  useEffect(() => () => focusApplier.cancel(), [focusApplier]);
  useEffect(() => {
    const focus = editor.pendingFocus;
    if (!focus) return;
    const index = renderedBlocks.findIndex((block) => block.id === focus.blockId);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "auto" });
    focusApplier.requestApply(toCoreFocus(focus), (applied) => {
      if (applied) editor.clearFocus(focus);
    });
  }, [editor, focusApplier, renderedBlocks, virtualizer]);
  const appliedExternalFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusBlockId) {
      appliedExternalFocus.current = null;
      return;
    }
    const focusKey = `${pageId}:${focusBlockId}`;
    if (appliedExternalFocus.current === focusKey) return;
    const index = renderedBlocks.findIndex((block) => block.id === focusBlockId);
    if (index < 0) {
      editor.reportFailure("The linked block is unavailable, deleted, or hidden inside a collapsed outline.");
      return;
    }
    appliedExternalFocus.current = focusKey;
    editor.dismissError();
    virtualizer.scrollToIndex(index, { align: "center" });
    editor.queueFocus({ blockId: focusBlockId, anchor: 0, focus: 0 });
  }, [editor, focusBlockId, pageId, renderedBlocks, virtualizer]);

  const focusBlockRow = useCallback((blockId: string) => {
    rowElements.current.get(blockId)
      ?.querySelector<HTMLElement>("[data-page-editor-row]")
      ?.focus();
  }, []);
  useLayoutEffect(() => {
    if (selectionMode && selectionFocusId) focusBlockRow(selectionFocusId);
  }, [focusBlockRow, selectionFocusId, selectionMode]);

  const selectBlock = (blockId: string, extend: boolean) => {
    setArmedAtomicDeleteId(null);
    if (extend) {
      selection.extend(blockId);
      setSelectionMode(true);
      setSelectionFocusId(blockId);
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) active.blur();
      focusBlockRow(blockId);
    } else {
      selection.select(blockId);
      setSelectionMode(false);
      setSelectionFocusId(null);
    }
    renderSelection();
  };

  const selectAtomicBlock = (blockId: string, extend: boolean, element: HTMLDivElement) => {
    setArmedAtomicDeleteId(null);
    if (extend) selection.extend(blockId);
    else selection.select(blockId);
    setSelectionMode(true);
    setSelectionFocusId(blockId);
    renderSelection();
    element.focus();
  };

  const queueAdjacentFocus = (focus: { blockId: string; anchor: number; focus: number } | null) => {
    if (!focus) {
      editor.queueFocus(null);
      return;
    }
    const target = renderedBlocks.find((block) => block.id === focus.blockId);
    if (target?.type !== "session_ref") {
      setArmedAtomicDeleteId(null);
      editor.queueFocus(focus);
      return;
    }
    selection.select(target.id);
    setArmedAtomicDeleteId(null);
    setSelectionMode(true);
    setSelectionFocusId(target.id);
    renderSelection();
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement) active.blur();
    const index = renderedBlocks.findIndex((block) => block.id === target.id);
    virtualizer.scrollToIndex(index, { align: "auto" });
    focusBlockRow(target.id);
  };

  const blockKeyInput = (
    block: PageDocumentBlock,
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    const snapshot = selection.getSnapshot();
    if (event.key === "Escape") {
      event.preventDefault();
      setArmedAtomicDeleteId(null);
      const restoreId = snapshot.anchorId ?? block.id;
      const restore = lastTextSelections.current.get(restoreId);
      selection.clear();
      setSelectionMode(false);
      setSelectionFocusId(null);
      renderSelection();
      if (restore) {
        editor.queueFocus({ blockId: restoreId, anchor: restore.anchor, focus: restore.focus });
      } else {
        event.currentTarget.blur();
      }
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setArmedAtomicDeleteId(null);
      const focusId = snapshot.focusId ?? block.id;
      const index = renderedBlocks.findIndex((candidate) => candidate.id === focusId);
      const target = renderedBlocks[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (!target) return;
      if (event.shiftKey) selection.extend(target.id);
      else selection.select(target.id);
      setSelectionMode(true);
      setSelectionFocusId(target.id);
      renderSelection();
      virtualizer.scrollToIndex(index + (event.key === "ArrowUp" ? -1 : 1), { align: "auto" });
      focusBlockRow(target.id);
      return;
    }
    if (event.key === "Enter") {
      if (block.type !== "session_ref") return;
      event.preventDefault();
      const sessionId = typeof block.properties.sessionId === "string"
        ? block.properties.sessionId
        : "";
      const session = sessionIndex.get(sessionId);
      if (session) onOpenSession?.(session);
      return;
    }
    if (event.key !== "Tab" && event.key !== "Backspace" && event.key !== "Delete") return;
    event.preventDefault();
    const targets = snapshot.blockIds.includes(block.id) ? snapshot.blockIds : [block.id];
    if ((event.key === "Backspace" || event.key === "Delete") && block.type === "session_ref" && targets.length === 1) {
      if (armedAtomicDeleteId !== block.id) {
        setArmedAtomicDeleteId(block.id);
        return;
      }
      setArmedAtomicDeleteId(null);
    } else {
      setArmedAtomicDeleteId(null);
    }
    const operation: EditorOperation = event.key === "Tab"
      ? { type: event.shiftKey ? "outdent" : "indent", blockIds: targets }
      : { type: "deleteSelection", blockIds: targets };
    void editor.run(operation, { restoreFocus: false });
  };

  const keyInput = (input: PageBlockEditorKeyInput, event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      lastTextSelections.current.set(input.block.id, { anchor: input.anchor, focus: input.focus });
      selection.select(input.block.id);
      setSelectionMode(true);
      setSelectionFocusId(input.block.id);
      renderSelection();
      input.element.blur();
      focusBlockRow(input.block.id);
      return;
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !input.isComposing &&
      !event.nativeEvent.isComposing &&
      input.block.textValue.trim() === "/세션" &&
      onCreateSessionDraft
    ) {
      event.preventDefault();
      onCreateSessionDraft({ pageId, blockId: input.block.id, expectedVersion: mutationVersion });
      return;
    }
    if (
      event.shiftKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      crossesVerticalBlockEdge(input, event.key, renderedBlocks)
    ) {
      event.preventDefault();
      const current = selection.getSnapshot();
      if (
        current.anchorId === null ||
        current.focusId === null ||
        !current.blockIds.includes(input.block.id)
      ) {
        selection.select(input.block.id);
      }
      selection.extendBy(event.key === "ArrowUp" ? -1 : 1);
      lastTextSelections.current.set(input.block.id, { anchor: input.anchor, focus: input.focus });
      setSelectionMode(true);
      setSelectionFocusId(selection.getSnapshot().focusId);
      renderSelection();
      input.element.blur();
      const focusId = selection.getSnapshot().focusId;
      if (focusId) focusBlockRow(focusId);
      return;
    }
    if (handleArrowNavigation(input, event, renderedBlocks, queueAdjacentFocus)) return;
    const selectedIds = selection.getSnapshot().blockIds;
    const targets = selectedIds.includes(input.block.id) ? selectedIds : [input.block.id];
    const operation = structuralOperation(input, event, targets);
    if (!operation || input.isComposing || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void editor.run(operation);
  };

  const pasteInput = (input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (input.isComposing) return;
    const selectedIds = selection.getSnapshot().blockIds;
    event.preventDefault();
    let payload;
    try {
      payload = readPageEditorClipboard(event.clipboardData);
    } catch {
      editor.reportFailure("The clipboard data could not be read. Nothing was changed.");
      return;
    }
    const operation: EditorOperation = selectedIds.length > 1
      ? {
          type: "pasteOverSelection",
          blockIds: selectedIds,
          placeholderTempId: uniqueTempId("paste-selection"),
          payload,
          tempIdPrefix: uniqueTempId("paste-tree"),
        }
      : {
          type: "paste",
          blockId: input.block.id,
          selection: { anchor: input.anchor, focus: input.focus },
          payload,
          tempIdPrefix: uniqueTempId("paste-tree"),
        };
    void editor.run(operation);
  };

  const copyOrCutInput = (
    _input: PageBlockEditorKeyInput,
    event: React.ClipboardEvent<HTMLTextAreaElement>,
    cut: boolean,
  ) => {
    const selectedIds = selection.getSnapshot().blockIds;
    if (selectedIds.length <= 1) return;
    event.preventDefault();
    const wrote = writeBlockSelectionClipboard(
      event.clipboardData,
      toEditorSnapshots(pageId, blocks),
      selectedIds,
    );
    if (!wrote) {
      editor.reportFailure("The clipboard could not be written. The selected blocks were not changed.");
      return;
    }
    if (cut) void editor.run({ type: "deleteSelection", blockIds: selectedIds });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="page-outliner">
      <PageEditorMutationStatus state={editor.state} onDismiss={editor.dismissError} onResync={editor.resync} />
      <PageEditorFeedback message={editor.feedback} onDismiss={editor.dismissFeedback} />
      {blocks.length === 0 ? (
        <div className="mx-auto mt-10 max-w-lg rounded-xl border border-glass-border bg-glass-surface/60 p-8 text-center">
          <p className="font-medium text-foreground">This page is empty.</p>
          <p className="mt-2 text-sm text-muted-foreground">Create the first block and start writing.</p>
          <button
            type="button"
            data-testid="page-editor-create-first"
            disabled={editor.state.status !== "idle"}
            className="mt-4 rounded-lg border border-glass-border px-4 py-2 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={() => { void editor.createFirstBlock(); }}
          >
            Start writing
          </button>
        </div>
      ) : (
        <div
          ref={scrollRef}
          role="tree"
          aria-label="Page outline editor"
          aria-multiselectable="true"
          className="min-h-0 flex-1 overflow-auto px-4 py-5"
        >
          <div role="none" className="relative mx-auto w-full max-w-4xl" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((item) => {
              const block = renderedBlocks[item.index];
              if (!block) return null;
              return (
                <div
                  key={block.id}
                  ref={(element) => {
                    if (element) {
                      rowElements.current.set(block.id, element);
                      virtualizer.measureElement(element);
                    } else {
                      rowElements.current.delete(block.id);
                    }
                  }}
                  role="none"
                  data-index={item.index}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <PageBlockRow
                    block={block}
                    depth={depths.get(block.id) ?? 0}
                    selected={selected.has(block.id)}
                    deleteArmed={armedAtomicDeleteId === block.id}
                    selectionSegment={pageEditorSelectionSegment(
                      block.id,
                      renderedBlocks[item.index - 1]?.id,
                      renderedBlocks[item.index + 1]?.id,
                      selected,
                    )}
                    onKeyInput={keyInput}
                    onPasteInput={pasteInput}
                    onCopyInput={(input, event) => copyOrCutInput(input, event, false)}
                    onCutInput={(input, event) => copyOrCutInput(input, event, true)}
                    onSelectBlock={selectBlock}
                    onSelectAtomicBlock={selectAtomicBlock}
                    onLocalInput={editor.noteLocalInput}
                    onBlockKeyInput={blockKeyInput}
                    onEditorHeightChange={remeasureEditorRow}
                    sessionIndex={sessionIndex}
                    lens={lens}
                    onOpenSession={onOpenSession}
                    onCreateSessionDraft={onCreateSessionDraft
                      ? () => onCreateSessionDraft({
                          pageId,
                          blockId: block.id,
                          expectedVersion: mutationVersion,
                        })
                      : undefined}
                    apiClient={apiClient}
                    onSelectSessionReference={(sessionId) => { void editor.convertToSessionReference(block.id, sessionId); }}
                    onOpenPage={onOpenPage}
                    onOpenBlock={onOpenBlock}
                    focusRequested={focusBlockId === block.id}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export { visibleOutlineBlocks } from "./page-outliner-operations";
