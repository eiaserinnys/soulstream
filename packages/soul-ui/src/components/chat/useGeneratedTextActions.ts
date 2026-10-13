import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ChatUiComposerHandle, RegisterGeneratedTextActions } from "../chat-ui/chat-ui-composer";

/** One exact append receipt; the existing composer remains the draft owner. */
export function useGeneratedTextActions({ sessionId, text, textRef, textareaRef, sending, onChangeText, register }: {
  sessionId: string | null;
  text: string;
  textRef: RefObject<string>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  sending: boolean;
  onChangeText: (value: string) => void;
  register?: RegisterGeneratedTextActions;
}) {
  const [receipt, setReceipt] = useState<{ sessionId: string; before: string; after: string } | null>(null);
  const focusEnd = useRef<number | null>(null);
  const clearUndo = useCallback(() => { setReceipt(null); focusEnd.current = null; }, []);
  useEffect(clearUndo, [clearUndo, sessionId]);
  useLayoutEffect(() => {
    if (focusEnd.current === null || !textareaRef.current) return;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(focusEnd.current, focusEnd.current);
    focusEnd.current = null;
  });
  const appendGeneratedText = useCallback<ChatUiComposerHandle["appendGeneratedText"]>((target, generated) => {
    const editor = textareaRef.current;
    if (target !== sessionId || !editor || editor.disabled || !editor.isConnected) return { ok: false, reason: "unavailable" };
    if (sending) return { ok: false, reason: "sending" };
    if (!generated) return { ok: true };
    const before = textRef.current;
    const after = before ? before + "\n\n" + generated : generated;
    onChangeText(after);
    setReceipt({ sessionId: target, before, after });
    focusEnd.current = after.length;
    return { ok: true };
  }, [onChangeText, sending, sessionId, textareaRef, textRef]);
  useEffect(() => {
    register?.({ appendGeneratedText });
    return () => register?.(null);
  }, [appendGeneratedText, register]);
  const changeText = useCallback((value: string) => {
    clearUndo(); onChangeText(value);
  }, [clearUndo, onChangeText]);
  const canUndo = receipt !== null && receipt.sessionId === sessionId && receipt.after === text;
  const undo = () => {
    if (!receipt || receipt.sessionId !== sessionId || textRef.current !== receipt.after) return;
    onChangeText(receipt.before);
    focusEnd.current = receipt.before.length;
    setReceipt(null);
  };
  return { changeText, canUndo, undo, clearUndo };
}
