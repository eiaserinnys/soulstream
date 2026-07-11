import type { PageDocumentBlock } from "../page";
import { PageBlockEditor, type PageBlockEditorKeyInput } from "./PageBlockEditor";

export function PageBlockRow({
  block,
  depth,
  selected,
  onKeyInput,
  onPasteInput,
  onSelectBlock,
  onEditorHeightChange,
}: {
  block: PageDocumentBlock;
  depth: number;
  selected: boolean;
  onKeyInput(input: PageBlockEditorKeyInput, event: React.KeyboardEvent<HTMLTextAreaElement>): void;
  onPasteInput(input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onSelectBlock(blockId: string, extend: boolean): void;
  onEditorHeightChange(blockId: string): void;
}) {
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
        onSelectBlock={onSelectBlock}
        onHeightChange={onEditorHeightChange}
      />
    </div>
  );
}
