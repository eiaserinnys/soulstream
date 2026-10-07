/**
 * PaperclipButton — 파일 첨부 다이얼로그를 여는 작은 트리거 버튼.
 * ChatInput 에서만 쓰이는 순수 프레젠테이션 컴포넌트.
 */

import { Paperclip } from "lucide-react";
import { DashboardIconCap } from "../DashboardIconCap";

interface PaperclipButtonProps {
  onClick: () => void;
  disabled?: boolean;
  presentation?: "default" | "manuscript";
}

export function PaperclipButton({ onClick, disabled, presentation = "default" }: PaperclipButtonProps) {
  return (
    <DashboardIconCap
      size="small"
      appearance={presentation === "manuscript" ? "bare" : "default"}
      label="Attach files"
      disabled={disabled}
      onClick={onClick}
      className="self-end"
    >
      <Paperclip className={presentation === "manuscript" ? "size-5" : "h-4 w-4"}
        strokeWidth={presentation === "manuscript" ? 1.4 : undefined}
        absoluteStrokeWidth={presentation === "manuscript"}
        aria-hidden="true" />
    </DashboardIconCap>
  );
}
