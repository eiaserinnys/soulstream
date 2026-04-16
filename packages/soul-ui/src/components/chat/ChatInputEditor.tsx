/**
 * ChatInputEditor — 라벨 영역 + textarea + 전송 버튼의 한 행을 렌더한다.
 *
 * ChatInput 의 render JSX 중 본문(입력 영역)을 분리하여 상위 컴포넌트가
 * 레이아웃/부가 UI(첨부 목록, 안내 문구, 에러, hidden file input)에 집중하도록 한다.
 *
 * 상태를 소유하지 않는 프레젠테이션 컴포넌트 — 모든 값은 props로 전달받는다.
 */

import { forwardRef } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

interface ChatInputEditorProps {
  text: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  placeholder: string;
  buttonLabel: string;
  modeIcon: string;
  modeLabel: string;
  borderColor: string;
  buttonColor: string;
  disabled: boolean; // 버튼 disabled
  textareaDisabled: boolean; // textarea disabled
}

export const ChatInputEditor = forwardRef<HTMLTextAreaElement, ChatInputEditorProps>(
  function ChatInputEditor(
    {
      text,
      onChangeText,
      onSend,
      placeholder,
      buttonLabel,
      modeIcon,
      modeLabel,
      borderColor,
      buttonColor,
      disabled,
      textareaDisabled,
    },
    ref,
  ) {
    // Ctrl+Enter / Cmd+Enter로 전송
    const handleKeyDown = (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        onSend();
      }
    };
    return (
      <>
        {/* Left column: labels + textarea */}
        <div className="flex-1 flex flex-col gap-1">
          {/* Labels row */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wide font-semibold">
              <span className="text-xs">{modeIcon}</span>
              {modeLabel}
            </div>
            <div className="text-xs text-muted-foreground/60">
              Ctrl+Enter to send
            </div>
          </div>
          {/* Textarea */}
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => onChangeText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={textareaDisabled}
            rows={1}
            className={cn(
              "w-full bg-input border border-border rounded-md py-1.5 px-2.5",
              "text-base text-foreground font-sans resize-none outline-none",
              "h-9 sm:h-8 max-h-[120px] leading-snug transition-colors duration-150",
              borderColor,
            )}
          />
        </div>
        {/* Right: button aligned to textarea bottom, matching textarea height (h-9 = 36px) */}
        <Button
          data-testid="send-button"
          onClick={onSend}
          disabled={disabled}
          size="sm"
          className={cn("self-end h-9 sm:h-8 text-base sm:text-sm", buttonColor)}
        >
          {buttonLabel}
        </Button>
      </>
    );
  },
);
