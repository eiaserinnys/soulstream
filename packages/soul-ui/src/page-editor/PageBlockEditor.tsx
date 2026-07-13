import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  createPageTextBinding,
  type PageApiClient,
  type PageDocumentBlock,
  type SessionSummaryIndex,
} from "../page";
import { PageReferenceAutocomplete, type ReferenceAutocompleteOption } from "./PageReferenceAutocomplete";
import { PageRichText } from "./PageRichText";
import { findReferenceTrigger, parseInlineReferences, replaceReferenceTrigger, type ReferenceTrigger } from "./page-reference-parser";

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
  apiClient,
  sessionIndex,
  onSelectSessionReference,
  onOpenPage,
  onOpenBlock,
  focusRequested = false,
}: {
  block: PageDocumentBlock;
  onKeyInput(input: PageBlockEditorKeyInput, event: React.KeyboardEvent<HTMLTextAreaElement>): void;
  onPasteInput(input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onCopyInput(input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onCutInput(input: PageBlockEditorKeyInput, event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onSelectBlock(blockId: string, extend: boolean): void;
  onHeightChange(blockId: string): void;
  apiClient: PageApiClient;
  sessionIndex: SessionSummaryIndex;
  onSelectSessionReference(sessionId: string): void;
  onOpenPage?(pageId: string): void;
  onOpenBlock?(pageId: string, blockId: string): void;
  focusRequested?: boolean;
}) {
  const binding = useMemo(() => createPageTextBinding(block.text), [block.text]);
  const snapshot = useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot);
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const extendFocus = useRef(false);
  const requestId = useRef(0);
  const [editing, setEditing] = useState(false);
  const [autocomplete, setAutocomplete] = useState<{
    trigger: ReferenceTrigger;
    options: ReferenceAutocompleteOption[];
    activeIndex: number;
    loading: boolean;
  } | null>(null);
  const hasReferences = useMemo(
    () => parseInlineReferences(snapshot.text).some((segment) => segment.kind !== "text"),
    [snapshot.text],
  );
  useEffect(() => () => binding.destroy(), [binding]);
  useEffect(() => {
    if (focusRequested) setEditing(true);
  }, [focusRequested]);
  useLayoutEffect(() => {
    if (!editing || !textarea.current) return;
    if (document.activeElement !== textarea.current) {
      textarea.current.focus();
      textarea.current.setSelectionRange(snapshot.text.length, snapshot.text.length);
    }
  }, [editing, snapshot.text.length]);
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

  const dismissAutocomplete = () => {
    requestId.current += 1;
    setAutocomplete(null);
  };

  const refreshAutocomplete = (value: string, caret: number) => {
    if (composing.current) {
      dismissAutocomplete();
      return;
    }
    const trigger = findReferenceTrigger(value, caret);
    if (!trigger) {
      dismissAutocomplete();
      return;
    }
    const query = trigger.query.trim().toLocaleLowerCase();
    const sessions = trigger.kind === "page"
      ? [...sessionIndex.values()]
          .filter((session) => sessionLabel(session).toLocaleLowerCase().includes(query))
          .slice(0, 8)
          .map<ReferenceAutocompleteOption>((session) => ({
            kind: "session",
            id: session.agentSessionId,
            label: sessionLabel(session),
            detail: session.status,
          }))
      : [];
    const currentRequest = ++requestId.current;
    setAutocomplete({ trigger, options: sessions, activeIndex: 0, loading: query.length > 0 });
    if (!query) return;
    const search = trigger.kind === "page"
      ? apiClient.searchPages(trigger.query.trim(), 12).then((response) => response.items.map<ReferenceAutocompleteOption>((page) => ({
          kind: "page", id: page.pageId, label: page.title, detail: "Page",
        })))
      : apiClient.searchBlocks(trigger.query.trim(), 12).then((response) => response.items.map<ReferenceAutocompleteOption>((block) => ({
          kind: "block", id: block.blockId, label: block.textPreview || block.blockId, detail: block.pageTitle,
        })));
    void search.then(
      (remote) => {
        if (requestId.current !== currentRequest) return;
        const options = [...remote, ...sessions];
        setAutocomplete({ trigger, options, activeIndex: 0, loading: false });
      },
      () => {
        if (requestId.current !== currentRequest) return;
        setAutocomplete({ trigger, options: sessions, activeIndex: 0, loading: false });
      },
    );
  };

  const chooseReference = (option: ReferenceAutocompleteOption) => {
    if (!autocomplete) return;
    dismissAutocomplete();
    if (option.kind === "session") {
      onSelectSessionReference(option.id);
      return;
    }
    const replacement = option.kind === "page" ? `[[${option.label}]]` : `((${option.id}))`;
    const next = replaceReferenceTrigger(snapshot.text, autocomplete.trigger, replacement);
    binding.replaceText(next.text, { anchor: next.caret, head: next.caret });
    requestAnimationFrame(() => textarea.current?.setSelectionRange(next.caret, next.caret));
  };

  if (!editing && hasReferences) {
    return (
      <PageRichText
        blockId={block.id}
        text={snapshot.text}
        apiClient={apiClient}
        onEdit={() => setEditing(true)}
        onOpenPage={onOpenPage}
        onOpenBlock={onOpenBlock}
      />
    );
  }

  return (
    <div className="relative w-full">
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
        setEditing(true);
        if (!extendFocus.current) onSelectBlock(block.id, false);
        extendFocus.current = false;
      }}
      onChange={(event) => {
        binding.replaceText(event.currentTarget.value, {
          anchor: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
          head: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
        });
        refreshAutocomplete(event.currentTarget.value, event.currentTarget.selectionEnd ?? event.currentTarget.value.length);
      }}
      onBlur={() => {
        dismissAutocomplete();
        if (hasReferences) setEditing(false);
      }}
      onSelect={(event) => binding.setSelection({
        anchor: event.currentTarget.selectionStart ?? 0,
        head: event.currentTarget.selectionEnd ?? 0,
      })}
      onCompositionStart={() => { composing.current = true; dismissAutocomplete(); }}
      onCompositionEnd={(event) => {
        composing.current = false;
        refreshAutocomplete(event.currentTarget.value, event.currentTarget.selectionEnd ?? event.currentTarget.value.length);
      }}
      onKeyDown={(event) => {
        if (autocomplete && !composing.current && !event.nativeEvent.isComposing) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setAutocomplete((current) => current ? {
              ...current,
              activeIndex: current.options.length === 0
                ? 0
                : (current.activeIndex + delta + current.options.length) % current.options.length,
            } : null);
            return;
          }
          if (event.key === "Enter" && autocomplete.options[autocomplete.activeIndex]) {
            event.preventDefault();
            chooseReference(autocomplete.options[autocomplete.activeIndex]!);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            dismissAutocomplete();
            return;
          }
        }
        onKeyInput(input(event.currentTarget), event);
      }}
      onPaste={(event) => onPasteInput(input(event.currentTarget), event)}
      onCopy={(event) => onCopyInput(input(event.currentTarget), event)}
      onCut={(event) => onCutInput(input(event.currentTarget), event)}
    />
    {autocomplete ? (
      <PageReferenceAutocomplete
        options={autocomplete.options}
        activeIndex={autocomplete.activeIndex}
        loading={autocomplete.loading}
        onChoose={chooseReference}
        onActiveIndexChange={(activeIndex) => setAutocomplete((current) => current ? { ...current, activeIndex } : null)}
      />
    ) : null}
    </div>
  );
}

function sessionLabel(session: SessionSummaryIndex extends ReadonlyMap<string, infer Value> ? Value : never): string {
  return session.displayName || session.prompt || session.agentName || session.agentSessionId;
}
