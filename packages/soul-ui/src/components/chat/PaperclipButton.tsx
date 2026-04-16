/**
 * PaperclipButton — 파일 첨부 다이얼로그를 여는 작은 트리거 버튼.
 * ChatInput 에서만 쓰이는 순수 프레젠테이션 컴포넌트.
 */

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
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
      </svg>
    </button>
  );
}
