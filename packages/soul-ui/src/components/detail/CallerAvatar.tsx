/**
 * CallerAvatar — caller_info 표시용 소형 원형 아바타.
 *
 * 우선순위:
 *  1. value.avatar_url 있으면 <img>로 표시
 *  2. 이미지 로드 실패(onError)·avatar_url 없음 → display_name 이니셜 fallback
 *  3. display_name 없음 → source별 fallback 아이콘 (CALLER_SOURCE_CONFIG)
 *
 * 순수 로직(이니셜 추출, source 매핑)은 caller-avatar-helpers.ts에 분리되어
 * vitest node 환경에서 단위 테스트됨.
 */

import { useState } from "react";
import { extractInitial, getCallerSourceConfig } from "./caller-avatar-helpers";

interface Props {
  value: Record<string, unknown>;
  /** 픽셀 단위 — 메타데이터 행 높이에 맞춤 (기본 28) */
  size?: number;
}

export function CallerAvatar({ value, size = 28 }: Props) {
  const [imgFailed, setImgFailed] = useState(false);
  const avatarUrl = typeof value.avatar_url === "string" ? value.avatar_url : "";
  const displayName = typeof value.display_name === "string" ? value.display_name : "";
  const config = getCallerSourceConfig(value.source);

  if (avatarUrl && !imgFailed) {
    return (
      <img
        src={avatarUrl}
        alt={displayName || "caller"}
        width={size}
        height={size}
        className="rounded-full object-cover shrink-0"
        onError={() => setImgFailed(true)}
      />
    );
  }

  // Fallback: display_name 있으면 이니셜, 없으면 source별 아이콘
  const fallbackText = displayName ? extractInitial(displayName) : config.fallbackIcon;
  return (
    <div
      className="rounded-full flex items-center justify-center bg-muted text-foreground/80 text-xs font-medium shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={displayName || `caller (${config.fallbackIcon})`}
    >
      {fallbackText}
    </div>
  );
}
