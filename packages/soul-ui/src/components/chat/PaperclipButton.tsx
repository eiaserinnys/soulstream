/**
 * PaperclipButton — 파일 첨부 다이얼로그를 여는 작은 트리거 버튼.
 * ChatInput 에서만 쓰이는 순수 프레젠테이션 컴포넌트.
 */

import { Paperclip } from "lucide-react";
import { DashboardIconCap } from "../DashboardIconCap";

interface PaperclipButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

export function PaperclipButton({ onClick, disabled }: PaperclipButtonProps) {
  return (
    <DashboardIconCap
      size="small"
      label="Attach files"
      disabled={disabled}
      onClick={onClick}
      className="self-end"
    >
      <Paperclip className="h-4 w-4" aria-hidden="true" />
    </DashboardIconCap>
  );
}
