/**
 * ChatInputEditor — 라벨 영역 + textarea + 전송 버튼의 한 행을 렌더한다.
 *
 * ChatInput 의 render JSX 중 본문(입력 영역)을 분리하여 상위 컴포넌트가
 * 레이아웃/부가 UI(첨부 목록, 안내 문구, 에러, hidden file input)에 집중하도록 한다.
 *
 * 상태를 소유하지 않는 프레젠테이션 컴포넌트 — 모든 값은 props로 전달받는다.
 */

import { forwardRef, type KeyboardEvent, type ClipboardEventHandler } from "react";
import { SendHorizontal } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button, type ButtonVariant } from "../ui/button";

interface ChatInputEditorProps {
  inputLabel?: string;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  text: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  placeholder: string;
  buttonLabel: string;
  modeIcon: string;
  modeLabel: string;
  borderColor: string;
  buttonVariant: Extract<ButtonVariant, "default" | "success" | "warning">;
  disabled: boolean; // 버튼 disabled
  textareaDisabled: boolean; // textarea disabled
}

export const ChatInputEditor = forwardRef<HTMLTextAreaElement, ChatInputEditorProps>(
  function ChatInputEditor(
    {
      text,
      inputLabel,
      onPaste,
      onChangeText,
      onSend,
      placeholder,
      buttonLabel,
      modeIcon,
      modeLabel,
      borderColor,
      buttonVariant,
      disabled,
      textareaDisabled,
    },
    ref,
  ) {
    // Ctrl+Enter / Cmd+Enter로 전송
    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        onSend();
      }
    };
    return (
      <>
        <div className="flex min-w-0 flex-1 items-end gap-2">
          {modeIcon ? <span
            data-slot="chat-input-mode"
            className="mb-2 flex h-5 min-w-5 shrink-0 items-center justify-center text-xs text-muted-foreground"
            title={modeLabel}
            aria-hidden="true"
          >
            {modeIcon}
          </span> : null}
          <textarea
            data-slot="chat-input-body"
            aria-label={inputLabel}
            onPaste={onPaste}
            ref={ref}
            value={text}
            onChange={(e) => onChangeText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={textareaDisabled}
            rows={1}
            className={cn(
              "min-h-9 w-full resize-none border-0 bg-transparent px-0 py-2",
              "font-sans text-base leading-snug text-foreground outline-none placeholder:text-muted-foreground/55",
              "max-h-[120px] transition-colors duration-150 sm:min-h-8",
              borderColor,
            )}
          />
        </div>
        <ChatSendButton onSend={onSend} disabled={disabled} label={buttonLabel} variant={buttonVariant} />
      </>
    );
  },
);

/** The chat send control, also used by card handoff. Size and icon stay canonical here. */
export function ChatSendButton({ onSend, disabled, label, variant = "default", className }: {
 onSend(): void; disabled: boolean; label: string;
 variant?: Extract<ButtonVariant, "default" | "success" | "warning">; className?: string;
}) {
 return <Button data-testid="send-button" onClick={onSend} disabled={disabled} size="icon"
  variant={variant} aria-label={label} title={label} data-button-variant={variant}
  className={cn("h-9 w-9 shrink-0 self-end rounded-full sm:h-8 sm:w-8", className)}>
  <SendHorizontal className="h-4 w-4" aria-hidden="true" />
 </Button>;
}
