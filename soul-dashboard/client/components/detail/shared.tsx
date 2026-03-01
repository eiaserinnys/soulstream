/**
 * Detail 컴포넌트 공통 유틸리티
 *
 * SectionLabel, CodeBlock 등 상세 뷰 컴포넌트에서
 * 공통으로 사용되는 스타일 요소를 정의합니다.
 */

import { cn } from "../../lib/cn";

/** 섹션 라벨 */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] text-muted-foreground uppercase tracking-[0.05em] mb-1">
      {children}
    </div>
  );
}

/** 코드 블록 */
export function CodeBlock({
  children,
  variant = "default",
  maxHeight = 300,
}: {
  children: React.ReactNode;
  variant?: "default" | "error";
  maxHeight?: number;
}) {
  return (
    <pre
      className={cn(
        "text-xs p-2.5 rounded-md overflow-auto m-0 whitespace-pre-wrap break-words font-mono",
        variant === "error"
          ? "text-destructive-foreground bg-destructive/8"
          : "text-muted-foreground bg-input",
      )}
      style={{ maxHeight }}
    >
      {children}
    </pre>
  );
}

/** JSON.stringify의 안전한 래퍼 (circular reference 방어) */
export function safeStringify(obj: unknown, indent = 2): string {
  try {
    return JSON.stringify(obj, null, indent);
  } catch {
    return String(obj);
  }
}
