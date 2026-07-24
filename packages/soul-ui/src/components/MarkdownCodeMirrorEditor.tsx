import { useEffect, useRef } from "react";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  indentWithTab,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, type Command, type KeyBinding } from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";

interface MarkdownCodeMirrorEditorProps {
  value: string;
  yText: Y.Text | null;
  awareness: Awareness | null;
  onChange: (value: string) => void;
  onBlur: () => void;
  onEscape: () => void;
  ariaLabel?: string;
}

interface MarkdownEditorExtensionOptions {
  yText: Y.Text | null;
  awareness: Awareness | null;
  undoManager: Y.UndoManager | null;
  onChange: (value: string) => void;
  onBlur: () => void;
  onEscape: () => void;
}

export function MarkdownCodeMirrorEditor({
  value,
  yText,
  awareness,
  onChange,
  onBlur,
  onEscape,
  ariaLabel,
}: MarkdownCodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacksRef = useRef({ onChange, onBlur, onEscape });
  const initialValueRef = useRef(value);

  useEffect(() => {
    callbacksRef.current = { onChange, onBlur, onEscape };
  }, [onBlur, onChange, onEscape]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const undoManager = yText ? new Y.UndoManager(yText) : null;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: yText ? yText.toString() : initialValueRef.current,
        extensions: createMarkdownEditorExtensions({
          yText,
          awareness,
          undoManager,
          onChange: (nextValue) => callbacksRef.current.onChange(nextValue),
          onBlur: () => callbacksRef.current.onBlur(),
          onEscape: () => callbacksRef.current.onEscape(),
        }),
      }),
    });

    if (ariaLabel) {
      view.contentDOM.setAttribute("aria-label", ariaLabel);
    }
    viewRef.current = view;
    view.focus();

    return () => {
      view.destroy();
      undoManager?.destroy();
      viewRef.current = null;
    };
  }, [ariaLabel, awareness, yText]);

  useEffect(() => {
    if (yText) return;
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value, yText]);

  return (
    <div
      ref={hostRef}
      className="h-full min-h-[360px] w-full"
      data-testid="markdown-codemirror-editor"
    />
  );
}

export function createMarkdownEditorExtensions({
  yText,
  awareness,
  undoManager,
  onChange,
  onBlur,
  onEscape,
}: MarkdownEditorExtensionOptions): Extension[] {
  return [
    markdown(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdownEditorTheme,
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      blur: () => {
        onBlur();
        return false;
      },
    }),
    keymap.of([
      {
        key: "Escape",
        run: () => {
          onEscape();
          return true;
        },
      },
      ...markdownFormattingKeymap,
      indentWithTab,
      ...defaultKeymap,
      ...(yText ? yUndoManagerKeymap : historyKeymap),
    ]),
    ...(yText
      ? [yCollab(yText, awareness, { undoManager: undoManager ?? false })]
      : [history()]),
  ];
}

const markdownFormattingKeymap: KeyBinding[] = [
  { any: runDeleteLineShortcut },
  { key: "Mod-b", run: unlessComposing(wrapSelection("**", "**")) },
  { key: "Mod-i", run: unlessComposing(wrapSelection("*", "*")) },
  { key: "Mod-k", run: unlessComposing(wrapSelection("[", "](url)")) },
  { key: "Mod-/", run: unlessComposing(wrapSelection("`", "`")) },
  { key: "Mod-]", run: unlessComposing(indentMore) },
  { key: "Mod-[", run: unlessComposing(indentLess) },
];

function runDeleteLineShortcut(view: EditorView, event: KeyboardEvent): boolean {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== "k") {
    return false;
  }
  return unlessComposing(deleteCurrentLine)(view);
}

function unlessComposing(command: Command): Command {
  return (view) => {
    if (view.composing || view.compositionStarted) return false;
    return command(view);
  };
}

function wrapSelection(prefix: string, suffix: string): Command {
  return (view) => {
    const transaction = view.state.changeByRange((range) => {
      const selected = view.state.sliceDoc(range.from, range.to);
      const insert = `${prefix}${selected}${suffix}`;
      const anchor = range.from + prefix.length;
      const head = anchor + selected.length;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: range.empty ? EditorSelection.cursor(anchor) : EditorSelection.range(anchor, head),
      };
    });
    view.dispatch({ ...transaction, scrollIntoView: true });
    return true;
  };
}

const deleteCurrentLine: Command = (view) => {
  const transaction = view.state.changeByRange((range) => {
    const line = view.state.doc.lineAt(range.head);
    const to = line.to < view.state.doc.length ? line.to + 1 : line.to;
    return {
      changes: { from: line.from, to, insert: "" },
      range: EditorSelection.cursor(line.from),
    };
  });
  view.dispatch({ ...transaction, scrollIntoView: true });
  return true;
};

const markdownEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    minHeight: "360px",
    border: "1px solid var(--border)",
    // 오버레이·제목·포커스 링과 일관되게 둥근 모서리(🔴18). 기존 radius 토큰만 재사용하고
    // overflow를 감춰 내부 스크롤러/콘텐츠가 둥근 모서리를 넘지 않게 한다.
    borderRadius: "var(--radius-lg)",
    overflow: "hidden",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
  },
  "&.cm-focused": {
    // 채팅 입력창과 동일한 둥근 사각형 + 회색 focus ring(ring-ring/50, 3px)을
    // 재사용한다. 기존 --ring 토큰만 사용(신규 토큰 없음).
    outline: "none",
    boxShadow: "0 0 0 3px color-mix(in srgb, var(--ring) 50%, transparent)",
  },
  ".cm-scroller": {
    minHeight: "360px",
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: "0.875rem",
    lineHeight: "1.625",
  },
  ".cm-content": {
    minHeight: "360px",
    padding: "0.75rem",
    caretColor: "var(--foreground)",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--ring) 28%, transparent) !important",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--foreground)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--foreground) 5%, transparent)",
  },
});
