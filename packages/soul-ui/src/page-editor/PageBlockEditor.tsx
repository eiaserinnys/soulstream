import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { createPageTextBinding, type PageDocumentBlock } from "../page";

export interface PageBlockEditorKeyInput {
  readonly block: PageDocumentBlock;
  readonly element: HTMLTextAreaElement;
  readonly anchor: number;
  readonly focus: number;
  readonly isComposing: boolean;
}

export function PageBlockEditor({
  block,
  onKeyInput,
  onPasteInput,
  onCopyInput,
  onCutInput,
  onSelectBlock,
  onHeightChange,
}: {
  block: PageDocumentBlock;
  onKeyInput(input: PageBlockEditorKeyInput, event: React.KeyboardEvent<HTMLTextAreaElement>): void;
  onPasteInput(input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onCopyInput(input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onCutInput(input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onSelectBlock(blockId: string, extend: boolean): void;
  onHeightChange(blockId: string): void;
}) {
  const binding = useMemo(() => createPageTextBinding(block.text), [block.text]);
  const snapshot = useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot);
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const extendFocus = useRef(false);
  useEffect(() => () => binding.destroy(), [binding]);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    let lastWidth = element.clientWidth;
    const fitHeight = () => {
      const previous = element.style.height;
      element.style.height = "0px";
      const next = `${Math.max(32, element.scrollHeight)}px`;
      element.style.height = next;
      if (previous !== next) onHeightChange(block.id);
    };
    fitHeight();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? element.clientWidth;
        if (width === lastWidth) return;
        lastWidth = width;
        fitHeight();
      });
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", fitHeight);
    return () => window.removeEventListener("resize", fitHeight);
  }, [block.id, onHeightChange, snapshot.text]);
  useLayoutEffect(() => {
    if (!snapshot.remote || !snapshot.selection || !textarea.current) return;
    textarea.current.setSelectionRange(snapshot.selection.anchor, snapshot.selection.head);
  }, [snapshot]);

  const input = (target: HTMLTextAreaElement): PageBlockEditorKeyInput => ({
    block,
    element: target,
    anchor: target.selectionStart ?? 0,
    focus: target.selectionEnd ?? 0,
    isComposing: composing.current,
  });

  return (
    <textarea
      ref={textarea}
      data-page-block-editor={block.id}
      aria-label={`Edit block ${block.id}`}
      rows={1}
      value={snapshot.text}
      className="min-h-8 w-full resize-none overflow-hidden bg-transparent py-1 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/70"
      placeholder="Type something…"
      onMouseDown={(event) => {
        extendFocus.current = event.shiftKey;
        onSelectBlock(block.id, event.shiftKey);
      }}
      onFocus={() => {
        if (!extendFocus.current) onSelectBlock(block.id, false);
        extendFocus.current = false;
      }}
      onChange={(event) => {
        binding.replaceText(event.currentTarget.value, {
          anchor: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
          head: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
        });
      }}
      onSelect={(event) => binding.setSelection({
        anchor: event.currentTarget.selectionStart ?? 0,
        head: event.currentTarget.selectionEnd ?? 0,
      })}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={(event) => onKeyInput(input(event.currentTarget), event)}
      onPaste={(event) => onPasteInput(input(event.currentTarget), event)}
      onCopy={(event) => onCopyInput(input(event.currentTarget), event)}
      onCut={(event) => onCutInput(input(event.currentTarget), event)}
    />
  );
}
