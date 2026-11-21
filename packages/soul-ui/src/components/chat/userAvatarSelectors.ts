import type { CallerInfo } from "@soulstream/wire-schema";
import type { MetadataEntry } from "../../shared/types";

export function extractCallerAvatarUrl(
  metadata: MetadataEntry[] | undefined,
): string | null {
  if (!metadata) return null;
  for (const m of metadata) {
    if (m.type === "caller_info" && m.value && typeof m.value === "object") {
      const url = m.value.avatar_url;
      if (typeof url === "string" && url.length > 0) return url;
      return null;
    }
  }
  return null;
}

/**
 * user 발신 메시지의 portraitUrl을 결정한다 (agent 발신은 호출자가 별도 분기).
 *
 * 우선순위:
 *   1) msgCallerInfo.avatar_url — 메시지 단위 발신자 신원 (멀티-소스 세션에서 메시지마다 다른 경우 정본)
 *   2) sessionAvatarUrl — 세션-수준 caller_info fallback (extractCallerAvatarUrl이 추출한 값)
 *
 * 비문자열·빈 문자열인 msgCallerInfo.avatar_url은 무시하고 다음 우선순위로 진행 (defensive).
 */
export function pickMessageAvatarUrl(
  msgCallerInfo: CallerInfo | undefined,
  sessionAvatarUrl: string | null,
): string | null {
  if (msgCallerInfo?.source === "external") return null;
  const mu = msgCallerInfo?.avatar_url;
  if (typeof mu === "string" && mu.length > 0) return mu;
  return sessionAvatarUrl;
}
