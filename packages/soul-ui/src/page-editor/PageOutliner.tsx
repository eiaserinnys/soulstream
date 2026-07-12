import {
  createPostRenderFocusSelectionApplier,
  decideHorizontalEdgeNavigation,
  decideVerticalEdgeNavigation,
  existingBlock,
  type EditorOperation,
  type FocusResult,
} from "@soulstream/page-editor-core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
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
import { measureTextareaCaretLines } from "./page-editor-caret-geometry";
import { readPageEditorClipboard, writeBlockSelectionClipboard } from "./page-editor-clipboard";
import { createContiguousBlockSelection } from "./page-editor-selection";
import { toEditorSnapshots, usePageEditorController } from "./usePageEditorController";

const ROW_HEIGHT = 40;
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
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const renderedBlocks = useMemo(() => visibleOutlineBlocks(blocks), [blocks]);
  const [, renderSelection] = useReducer((value) => value + 1, 0);
  const selection = useMemo(
    () => createContiguousBlockSelection(renderedBlocks.map((block) => block.id)),
    [pageId],
  );
  selection.replaceBlockOrder(renderedBlocks.map((block) => block.id));
  const selectionSnapshot = selection.getSnapshot();
  const selected = new Set(selectionSnapshot.blockIds);
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

  const selectBlock = (blockId: string, extend: boolean) => {
    if (extend) selection.extend(blockId);
    else selection.select(blockId);
    renderSelection();
  };

  const keyInput = (input: PageBlockEditorKeyInput, event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      renderSelection();
      return;
    }
    if (handleArrowNavigation(input, event, renderedBlocks, editor.queueFocus)) return;
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
      <MutationStatus state={editor.state} onDismiss={editor.dismissError} onResync={editor.resync} />
      <EditorFeedback message={editor.feedback} onDismiss={editor.dismissFeedback} />
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
                    onKeyInput={keyInput}
                    onPasteInput={pasteInput}
                    onCopyInput={(input, event) => copyOrCutInput(input, event, false)}
                    onCutInput={(input, event) => copyOrCutInput(input, event, true)}
                    onSelectBlock={selectBlock}
                    onEditorHeightChange={remeasureEditorRow}
                    sessionIndex={sessionIndex}
                    lens={lens}
                    onOpenSession={onOpenSession}
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

function structuralOperation(
  input: PageBlockEditorKeyInput,
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  selectedIds: readonly string[],
): EditorOperation | null {
  const range = { anchor: input.anchor, focus: input.focus };
  if (event.key === "Enter") return { type: "splitBlock", blockId: input.block.id, selection: range, newBlockTempId: uniqueTempId("split"), isComposing: input.isComposing };
  if (event.key === "Tab") {
    return {
      type: event.shiftKey ? "outdent" : "indent",
      blockIds: selectedIds,
      focus: { blockId: input.block.id, selection: range },
    };
  }
  if (event.key === "Backspace") {
    if (selectedIds.length > 1) return { type: "deleteSelection", blockIds: selectedIds };
    return input.anchor === input.focus && input.focus === 0
      ? { type: "mergePrevious", blockId: input.block.id, selection: range, isComposing: input.isComposing }
      : null;
  }
  if (event.key === "Delete") {
    if (selectedIds.length > 1) return { type: "deleteSelection", blockIds: selectedIds };
    return input.anchor === input.focus && input.focus === input.block.textValue.length
      ? { type: "mergeNext", blockId: input.block.id, selection: range, isComposing: input.isComposing }
      : null;
  }
  return null;
}

function handleArrowNavigation(
  input: PageBlockEditorKeyInput,
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  blocks: readonly PageDocumentBlock[],
  queueFocus: (focus: { blockId: string; anchor: number; focus: number } | null) => void,
): boolean {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) || event.shiftKey) return false;
  const index = blocks.findIndex((block) => block.id === input.block.id);
  const previous = blocks[index - 1];
  const next = blocks[index + 1];
  const adjacent = (block: PageDocumentBlock | undefined) => block
    ? { target: existingBlock(block.id), textLength: block.textValue.length }
    : null;
  const selection = { anchor: input.anchor, focus: input.focus };
  const decision = event.key === "ArrowLeft" || event.key === "ArrowRight"
    ? decideHorizontalEdgeNavigation({
        direction: event.key === "ArrowLeft" ? "left" : "right",
        selection,
        textLength: input.block.textValue.length,
        previousBlock: adjacent(previous),
        nextBlock: adjacent(next),
      })
    : decideVerticalEdgeNavigation({
        direction: event.key === "ArrowUp" ? "up" : "down",
        selection,
        metrics: measureTextareaCaretLines(input.element, input.focus),
        previousBlock: adjacent(previous),
        nextBlock: adjacent(next),
      });
  if (decision.kind === "native") return false;
  event.preventDefault();
  const target = decision.focus.target;
  queueFocus({
    blockId: target.kind === "existing" ? target.blockId : target.tempId,
    anchor: decision.focus.selection.anchor,
    focus: decision.focus.selection.focus,
  });
  return true;
}

function crossesVerticalBlockEdge(
  input: PageBlockEditorKeyInput,
  key: "ArrowUp" | "ArrowDown",
  blocks: readonly PageDocumentBlock[],
): boolean {
  const index = blocks.findIndex((block) => block.id === input.block.id);
  const adjacent = key === "ArrowUp" ? blocks[index - 1] : blocks[index + 1];
  if (!adjacent) return false;
  return decideVerticalEdgeNavigation({
    direction: key === "ArrowUp" ? "up" : "down",
    selection: { anchor: input.anchor, focus: input.focus },
    metrics: measureTextareaCaretLines(input.element, input.focus),
    previousBlock: key === "ArrowUp" ? { target: existingBlock(adjacent.id), textLength: adjacent.textValue.length } : null,
    nextBlock: key === "ArrowDown" ? { target: existingBlock(adjacent.id), textLength: adjacent.textValue.length } : null,
  }).kind === "focus";
}

function MutationStatus({ state, onDismiss, onResync }: {
  state: ReturnType<typeof usePageEditorController>["state"];
  onDismiss(): void;
  onResync(): void;
}) {
  if (state.status === "idle") return null;
  const pending = state.status === "pending" || state.status === "resyncing";
  return (
    <div
      role={pending ? "status" : "alert"}
      aria-live="polite"
      data-editor-state={state.status}
      className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-glass-border bg-glass-surface/80 px-3 py-2 text-sm text-foreground"
    >
      {pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <AlertTriangle aria-hidden="true" className="h-4 w-4 text-warning" />}
      <span className="flex-1">{state.message}</span>
      {state.status === "conflict" ? (
        <button type="button" data-testid="page-editor-resync" className="inline-flex items-center gap-1 rounded px-2 py-1 focus-visible:ring-2 focus-visible:ring-primary" onClick={onResync}>
          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" /> Reload
        </button>
      ) : state.status === "error" ? (
        <button type="button" aria-label="Dismiss editor error" className="rounded p-1 focus-visible:ring-2 focus-visible:ring-primary" onClick={onDismiss}>
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

function EditorFeedback({ message, onDismiss }: { message: string | null; onDismiss(): void }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      aria-live="polite"
      data-editor-feedback="error"
      className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-glass-border bg-glass-surface/80 px-3 py-2 text-sm text-foreground"
    >
      <AlertTriangle aria-hidden="true" className="h-4 w-4 text-warning" />
      <span className="flex-1">{message}</span>
      <button type="button" aria-label="Dismiss editor feedback" className="rounded p-1 focus-visible:ring-2 focus-visible:ring-primary" onClick={onDismiss}>
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}

function outlineDepths(blocks: readonly PageDocumentBlock[]): ReadonlyMap<string, number> {
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const depths = new Map<string, number>();
  for (const block of blocks) {
    let depth = 0;
    let parentId = block.parentId;
    const visited = new Set<string>([block.id]);
    while (parentId && byId.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    depths.set(block.id, depth);
  }
  return depths;
}

export function visibleOutlineBlocks(
  blocks: readonly PageDocumentBlock[],
): readonly PageDocumentBlock[] {
  const hiddenParents = new Set<string>();
  const visible: PageDocumentBlock[] = [];
  for (const block of blocks) {
    if (block.parentId !== null && hiddenParents.has(block.parentId)) {
      hiddenParents.add(block.id);
      continue;
    }
    visible.push(block);
    if (block.collapsed) hiddenParents.add(block.id);
  }
  return visible;
}

function toCoreFocus(focus: { blockId: string; anchor: number; focus: number }): FocusResult {
  return { target: existingBlock(focus.blockId), selection: { anchor: focus.anchor, focus: focus.focus } };
}

function uniqueTempId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function cssEscape(value: string): string {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}
