import {
  resolveSessionReference,
  sessionLensState,
  SessionRefBlock,
  type PageDocumentBlock,
  type PageLens,
  type SessionSummaryIndex,
} from "../page";
import type { SessionSummary } from "../shared/types";
import { PageBlockEditor, type PageBlockEditorKeyInput } from "./PageBlockEditor";
import {
  PAGE_EDITOR_ROW_TOKENS,
  pageEditorRowStyle,
  type PageEditorSelectionSegment,
} from "./page-editor-visual-tokens";

export function PageBlockRow({
  block,
  depth,
  selected,
  deleteArmed,
  selectionSegment,
  onKeyInput,
  onPasteInput,
  onCopyInput,
  onCutInput,
  onSelectBlock,
  onSelectAtomicBlock,
  onSelectionDragStart,
  onSelectionDragEnter,
  onLocalInput,
  onBlockKeyInput,
  onEditorHeightChange,
  sessionIndex,
  lens,
  onOpenSession,
  onCreateSessionDraft,
  apiClient,
  onSelectSessionReference,
  onOpenPage,
  onOpenBlock,
  focusRequested,
}: {
  block: PageDocumentBlock;
  depth: number;
  selected: boolean;
  deleteArmed: boolean;
  selectionSegment: PageEditorSelectionSegment | null;
  onKeyInput(input: PageBlockEditorKeyInput, event: React.KeyboardEvent<HTMLTextAreaElement>): void;
  onPasteInput(input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onCopyInput(input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onCutInput(input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onSelectBlock(blockId: string, extend: boolean): void;
  onSelectAtomicBlock(blockId: string, extend: boolean, element: HTMLDivElement): void;
  onSelectionDragStart(blockId: string): void;
  onSelectionDragEnter(blockId: string): void;
  onLocalInput(): void;
  onBlockKeyInput(block: PageDocumentBlock, event: React.KeyboardEvent<HTMLDivElement>): void;
  onEditorHeightChange(blockId: string): void;
  sessionIndex: SessionSummaryIndex;
  lens: PageLens;
  onOpenSession?(session: SessionSummary): void;
  onCreateSessionDraft?(): void;
  apiClient: import("../page").PageApiClient;
  onSelectSessionReference(sessionId: string): void;
  onOpenPage?(pageId: string): void;
  onOpenBlock?(pageId: string, blockId: string): void;
  focusRequested?: boolean;
}) {
  if (block.type === "session_ref") {
    const sessionId = typeof block.properties.sessionId === "string"
      ? block.properties.sessionId
      : "";
    const resolution = sessionId
      ? resolveSessionReference(sessionIndex, sessionId)
      : {
        kind: "unavailable" as const,
        sessionId: "invalid reference",
        message: "Session unavailable — this block has no valid sessionId.",
      };
    return (
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selected}
        data-page-editor-row
        data-block-id={block.id}
        data-outline-depth={depth}
        data-block-type="session_ref"
        data-delete-confirmation={deleteArmed ? "armed" : undefined}
        tabIndex={selected ? 0 : -1}
        title={deleteArmed ? "Press Delete or Backspace again to remove this session reference" : undefined}
        className={`${PAGE_EDITOR_ROW_TOKENS.base} outline-none ${
          deleteArmed
            ? `${PAGE_EDITOR_ROW_TOKENS.deleteArmed} rounded-lg`
            : selected && selectionSegment
            ? `${PAGE_EDITOR_ROW_TOKENS.selected} ${PAGE_EDITOR_ROW_TOKENS.selectionRadius[selectionSegment]}`
            : PAGE_EDITOR_ROW_TOKENS.idle
        }`}
        style={pageEditorRowStyle(depth)}
        onClick={(event) => onSelectAtomicBlock(block.id, event.shiftKey, event.currentTarget)}
        onMouseMove={() => onSelectionDragEnter(block.id)}
        onDoubleClick={() => {
          if (resolution.kind === "ready") onOpenSession?.(resolution.summary);
        }}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget) onBlockKeyInput(block, event);
        }}
      >
        <SelectionHandle
          blockId={block.id}
          onDragStart={onSelectionDragStart}
          colorClass="bg-primary/70"
        />
        <SessionRefBlock
          resolution={resolution}
          lensState={sessionLensState(
            resolution.kind === "ready" ? resolution.summary.status : undefined,
            lens,
          )}
          onOpen={() => {
            if (resolution.kind === "ready") onOpenSession?.(resolution.summary);
          }}
          displayOnly
          showOpenButton
        />
      </div>
    );
  }

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      data-page-editor-row
      data-block-id={block.id}
      data-outline-depth={depth}
      tabIndex={selected ? 0 : -1}
      className={`${PAGE_EDITOR_ROW_TOKENS.base} ${
        selected && selectionSegment
          ? `${PAGE_EDITOR_ROW_TOKENS.selected} ${PAGE_EDITOR_ROW_TOKENS.selectionRadius[selectionSegment]}`
          : PAGE_EDITOR_ROW_TOKENS.idle
      }`}
      style={pageEditorRowStyle(depth)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget) onBlockKeyInput(block, event);
      }}
      onMouseMove={() => onSelectionDragEnter(block.id)}
    >
      <SelectionHandle
        blockId={block.id}
        onDragStart={onSelectionDragStart}
        colorClass="bg-muted-foreground/70"
      />
      <PageBlockEditor
        block={block}
        onKeyInput={onKeyInput}
        onPasteInput={onPasteInput}
        onCopyInput={onCopyInput}
        onCutInput={onCutInput}
        onSelectBlock={onSelectBlock}
        onLocalInput={onLocalInput}
        onHeightChange={onEditorHeightChange}
        apiClient={apiClient}
        sessionIndex={sessionIndex}
        onSelectSessionReference={onSelectSessionReference}
        onOpenPage={onOpenPage}
        onOpenBlock={onOpenBlock}
        focusRequested={focusRequested}
        blockSelectionMode={selected}
      />
      {block.textValue.trim() === "/세션" && onCreateSessionDraft ? (
        <button
          type="button"
          data-testid={`page-session-command-${block.id}`}
          className="mt-0.5 shrink-0 rounded-md border border-primary/40 px-2 py-1 text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCreateSessionDraft}
        >
          세션 draft
        </button>
      ) : null}
    </div>
  );
}

function SelectionHandle({
  blockId,
  onDragStart,
  colorClass,
}: {
  blockId: string;
  onDragStart(blockId: string): void;
  colorClass: string;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`Select block ${blockId}`}
      data-page-selection-handle={blockId}
      className="flex h-6 w-3 shrink-0 items-center justify-center self-center cursor-grab"
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        onDragStart(blockId);
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${colorClass}`} />
    </button>
  );
}
