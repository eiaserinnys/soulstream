/**
 * BackendBadge - 세션의 backend(claude/codex 등)를 시각적으로 표시.
 *
 * SessionItem 우측 배지 영역에서 사용. 폴더 헤더 표시는 후속 카드.
 */
import { Badge } from "./ui/badge";
import { cn } from "../lib/cn";

export interface BackendStyle {
  label: string;
  className: string;
}

export const BACKEND_STYLE: Record<string, BackendStyle> = {
  claude: {
    label: "Claude",
    className: "bg-blue-500/10 text-blue-700 border-blue-500/30 dark:text-blue-300",
  },
  codex: {
    label: "Codex",
    className: "bg-purple-500/10 text-purple-700 border-purple-500/30 dark:text-purple-300",
  },
};

/** 알려진 backend면 사전 정의 스타일, 그 외는 verbatim 라벨 + 빈 스타일. */
export function resolveBackendStyle(backend: string): BackendStyle {
  return BACKEND_STYLE[backend] ?? { label: backend, className: "" };
}

export interface BackendBadgeProps {
  backend: string;
  className?: string;
}

export function BackendBadge({ backend, className }: BackendBadgeProps) {
  const style = resolveBackendStyle(backend);
  return (
    <Badge variant="outline" size="sm" className={cn(style.className, className)}>
      {style.label}
    </Badge>
  );
}
