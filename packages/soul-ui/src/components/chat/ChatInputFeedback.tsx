import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useChatUiFeedback } from "../chat-ui/ChatUiControllerProvider";

/** The editor's actual start, including its existing controls, owns this inset. */
export function ChatInputFeedback({ textareaRef }: { textareaRef: RefObject<HTMLTextAreaElement | null> }) {
  const { feedback, open } = useChatUiFeedback();
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [inset, setInset] = useState(0);
  useLayoutEffect(() => {
    const editor = textareaRef.current;
    const parent = noticeRef.current?.parentElement;
    if (!editor || !parent) return;
    const align = () => setInset(editor.getBoundingClientRect().left - parent.getBoundingClientRect().left);
    align();
    const observer = new ResizeObserver(align);
    observer.observe(editor); observer.observe(parent);
    return () => observer.disconnect();
  }, [open, textareaRef]);
  return open ? <p ref={noticeRef} role="status" className="chat-ui-meta mt-2 mb-0 h-[1lh] overflow-hidden whitespace-nowrap" style={{ paddingInlineStart: inset }}>{feedback}</p> : null;
}
