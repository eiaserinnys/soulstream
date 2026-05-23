/**
 * PaperclipButton — 파일 첨부 다이얼로그를 여는 작은 트리거 버튼.
 * ChatInput 에서만 쓰이는 순수 프레젠테이션 컴포넌트.
 */

import { Paperclip } from "lucide-react";

interface PaperclipButtonProps {
  onClick: () => void;
}

export function PaperclipButton({ onClick }: PaperclipButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="self-end h-9 sm:h-8 px-2 flex items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors"
      title="Attach files"
    >
      <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
