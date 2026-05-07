/**
 * 채팅 메시지 영역의 사용자 측 아바타 데이터 소스 결정 helper.
 *
 * 사용자가 *현재 보고 있는* 채팅 영역에서 user 발신 메시지의 portraitUrl이
 * caller_info(통합 스키마 v1, atom card `ed3a216d`) 기반이 되도록 한다.
 *
 * UserMessage 컴포넌트는 단위 테스트 표면이 부재(grep 결과)이므로 selector를
 * 순수 함수로 분리해 vitest로 직접 검증 가능한 형태로 둔다 (design-principles §10).
 *
 * 우선순위:
 *   1) 메시지 단위 caller_info (msg.callerInfo) — 멀티-소스 세션에서 메시지마다 발신자가 다를 때
 *   2) 세션 단위 caller_info (activeSessionSummary.metadata) — 세션 발신자 fallback
 *   3) 노드 단일 사용자 (dashboardConfig.user.portraitUrl) — caller_info 부재 세션 호환
 */

import type { CallerInfo, MetadataEntry } from "../../shared/types";

/**
 * SessionSummary.metadata 배열에서 caller_info entry의 avatar_url을 추출한다.
 *
 * - 첫 번째 `type === "caller_info"`인 object value entry의 `avatar_url`만 본다.
 *   세션당 caller_info가 1개라는 통합 스키마 v1 전제.
 * - `avatar_url`이 비문자열·빈 문자열이거나 entry 자체가 없으면 null.
 *
 * `MetadataEntry.value`는 `string | Record<string, unknown>`이며 `typeof === "object"`
 * narrowing이 자동으로 후자로 좁히므로 `as` 캐스팅은 불필요하다.
 */
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
 *   3) userPortraitUrl — 노드 단일 사용자 dashboardConfig fallback (caller_info 부재 세션 호환)
 *
 * 비문자열·빈 문자열인 msgCallerInfo.avatar_url은 무시하고 다음 우선순위로 진행 (defensive).
 */
export function pickMessageAvatarUrl(
  msgCallerInfo: CallerInfo | undefined,
  sessionAvatarUrl: string | null,
  userPortraitUrl: string | null | undefined,
): string | null {
  const mu = msgCallerInfo?.avatar_url;
  if (typeof mu === "string" && mu.length > 0) return mu;
  return sessionAvatarUrl ?? userPortraitUrl ?? null;
}
