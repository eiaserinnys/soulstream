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

export function PageBlockRow({
  block,
  depth,
  selected,
  onKeyInput,
  onPasteInput,
  onCopyInput,
  onCutInput,
  onSelectBlock,
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
  onKeyInput(input: PageBlockEditorKeyInput, event: React.KeyboardEvent<HTMLTextAreaElement>): void;
  onPasteInput(input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onCopyInput(input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onCutInput(input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onSelectBlock(blockId: string, extend: boolean): void;
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
        className="flex min-h-10 items-start gap-2 rounded-lg px-2 py-1"
        style={{ paddingInlineStart: `${8 + depth * 24}px` }}
      >
        <span aria-hidden="true" className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
        <SessionRefBlock
          resolution={resolution}
          lensState={sessionLensState(
            resolution.kind === "ready" ? resolution.summary.status : undefined,
            lens,
          )}
          onOpen={() => {
            if (resolution.kind === "ready") onOpenSession?.(resolution.summary);
          }}
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
      className={`flex min-h-10 items-start gap-2 rounded-lg px-2 py-1 transition-colors ${
        selected ? "bg-primary/12 ring-1 ring-primary/30" : "hover:bg-glass-highlight/50"
      }`}
      style={{ paddingInlineStart: `${8 + depth * 24}px` }}
    >
      <span aria-hidden="true" className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/70" />
      <PageBlockEditor
        block={block}
        onKeyInput={onKeyInput}
        onPasteInput={onPasteInput}
        onCopyInput={onCopyInput}
        onCutInput={onCutInput}
        onSelectBlock={onSelectBlock}
        onHeightChange={onEditorHeightChange}
        apiClient={apiClient}
        sessionIndex={sessionIndex}
        onSelectSessionReference={onSelectSessionReference}
        onOpenPage={onOpenPage}
        onOpenBlock={onOpenBlock}
        focusRequested={focusRequested}
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
