import { useTranslation } from "react-i18next";
import type { HTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "../lib/cn";

export interface FrameLoadingProps extends HTMLAttributes<HTMLDivElement> {
  /** 로딩 문구. 없으면 스피너만 그리고 접근 이름은 "불러오는 중"을 쓴다. */
  label?: ReactNode;
  /** 내용 높이로 정해지는 좁은 자리(팝오버, 사이드바 구역, 요약 줄)에서 쓰는 한 줄 모양. */
  inline?: boolean;
}

/**
 * 프레임 로딩 표시. 스피너와 짧은 글자를 한 줄로 나란히 두고 부모 프레임의
 * 가로·세로 가운데에 세운다. 부모가 flex 컨테이너이면 남은 높이를 채운다.
 */
export function FrameLoading({
  label,
  inline = false,
  className,
  ...props
}: FrameLoadingProps) {
  const { t } = useTranslation();
  const accessibleName =
    typeof label === "string" && label.trim() ? label.trim() : t("ui.common.loading");

  return (
    <div
      data-slot="frame-loading"
      data-inline={inline || undefined}
      role="status"
      aria-label={accessibleName}
      aria-live="polite"
      className={cn("v3-frame-seat", "v3-frame-loading", className)}
      {...props}
    >
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
      {label ? <span className="v3-frame-loading-label">{label}</span> : null}
    </div>
  );
}
