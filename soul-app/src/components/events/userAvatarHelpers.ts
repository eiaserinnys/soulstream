/**
 * 채팅 메시지 영역의 사용자 측 아바타 데이터 소스 결정 helper (soul-app).
 *
 * PR #7(`7731440`)이 user 메시지 아바타에 *현재 로그인한 본인 Google picture*를
 * 무조건 우선시하여 슬랙·위임 에이전트 발신 메시지에도 본인 picture가 표시되는 결함을
 * 본 모듈이 닫는다. user_message 이벤트의 발신자 신원(통합 스키마 v1, atom card
 * `ed3a216d`)을 추출하여 source별 아바타로 분기한다.
 *
 * 발신자가 명시되어 있으면(*caller*) `caller.avatar_url`을 권위로 사용한다.
 * 서버(`soul-server/cogito/mcp_session_mgmt.py:99-105`)는 portrait_path가 있을 때만
 * avatar_url을 채워주고 없으면 None을 보낸다 — 클라이언트는 source=agent라고 추정해서
 * URL을 재조립하지 않는다 (design-principles §1·§3·§6: 지식 경계, 정본 하나, 파라미터 전달).
 *
 * caller 부재 메시지(본인 발신)는 PR #7 흐름을 그대로 유지: Google picture →
 * fallbackPortraitUrl → null.
 *
 * UserMessage/AssistantMessage 컴포넌트는 RN 단위 테스트 표면이 부재이므로 picker
 * 로직을 순수 함수로 분리해 jest로 검증 (design-principles §10).
 *
 * 정본 동기화: web `packages/soul-ui/src/components/chat/userAvatarSelectors.ts`의
 * `pickUserPortraitUrl`과 의도가 동일하다. RN은 별 리포라 직접 import 불가.
 */

import type { GoogleProfile } from '../../auth/jwt-payload';
import type { SessionEvent } from '../../api/types';

/**
 * 메시지 단위 발신자 신원 — 통합 caller_info 스키마 v1.
 *
 * 현재 wire format(`soul-server/service/task_executor.py:148-160`)은
 * `event.data.caller_info` nested sub-dict로 보낸다. 향후 flat top-level promote
 * 가능성에 대비하여 `extractMessageCaller`가 양 위치 모두 시도한다.
 */
export interface MessageCaller {
  /**
   * F-11 (2026-05-09): 'system' 추가 — soulstream 서버 lifecycle 인터벤션 발신자
   * (graceful_shutdown 종료 예고, resume_shutdown_sessions 재개 안내). soul-ui CallerInfo
   * union과 정합 (atom ed3a216d).
   */
  source?: 'slack' | 'browser' | 'soul-app' | 'agent' | 'api' | 'system';
  display_name?: string;
  /** 외부 CDN URL(slack image_192/google picture) 또는 노드 서버 상대 경로(/api/nodes/...). */
  avatar_url?: string;
  user_id?: string;
  email?: string;
  agent_node?: string;
  agent_id?: string | null;
  agent_name?: string | null;
  slack?: { channel_id?: string; user_id?: string; thread_ts?: string };
}

/**
 * SessionEvent에서 메시지 발신자 신원을 추출한다.
 *
 * - 우선순위 1: `event.data.caller_info` (현재 wire format — nested dict)
 * - 우선순위 2: `event.data` 자체의 flat top-level 키 (소울스트림 형식 변동 대비)
 * - 어느 필드도 차 있지 않으면 null (= 진짜 본인 발신으로 간주)
 *
 * `null` vs `{}`을 구분하기 위해 어느 한 필드라도 채워졌을 때만 객체를 반환.
 */
export function extractMessageCaller(
  event: SessionEvent | undefined,
): MessageCaller | null {
  const d = event?.data as Record<string, unknown> | undefined;
  if (!d) return null;
  const fromNested =
    d.caller_info && typeof d.caller_info === 'object'
      ? (d.caller_info as Record<string, unknown>)
      : null;
  const src = (fromNested ?? d) as Record<string, unknown>;

  const out: MessageCaller = {};
  if (typeof src.source === 'string') {
    out.source = src.source as MessageCaller['source'];
  }
  if (typeof src.display_name === 'string') out.display_name = src.display_name;
  if (typeof src.avatar_url === 'string') out.avatar_url = src.avatar_url;
  if (typeof src.user_id === 'string') out.user_id = src.user_id;
  if (typeof src.email === 'string') out.email = src.email;
  if (typeof src.agent_node === 'string') out.agent_node = src.agent_node;
  if (typeof src.agent_id === 'string' || src.agent_id === null) {
    out.agent_id = src.agent_id as string | null;
  }
  if (typeof src.agent_name === 'string' || src.agent_name === null) {
    out.agent_name = src.agent_name as string | null;
  }
  if (src.slack && typeof src.slack === 'object') {
    out.slack = src.slack as MessageCaller['slack'];
  }
  return Object.keys(out).length === 0 ? null : out;
}

export interface UserAvatarUriResult {
  uri: string | null;
  /**
   * 외부 CDN URL(google picture·slack image_192)은 false — Authorization 헤더 없이 로드.
   * 노드 서버 상대 URL(/api/nodes/...)은 true — Bearer 헤더 첨부.
   */
  useBearer: boolean;
}

/**
 * UserMessage/AssistantMessage 아바타 URI 우선순위.
 *
 * 1. caller가 명시되어 있으면(슬랙/위임 에이전트 등 *본인이 아닌* 발신자):
 *    `caller.avatar_url`만 신뢰. 외부 URL이면 그대로, 상대 URL이면 serverUrl prepend.
 *    avatar_url 부재(예: portrait 미설정 에이전트)는 null 반환 — fallback char로.
 *
 * 2. caller 부재(본인 발신):
 *    Google profile picture → fallbackPortraitUrl(외부/상대) → null.
 *    이 흐름은 PR #7과 동일.
 *
 * @param caller 메시지 발신자 신원. null이면 본인 발신으로 간주.
 * @param profile 현재 로그인한 본인의 Google 프로필 — 본인 발신 케이스에만 사용.
 * @param fallbackPortraitUrl session.userPortraitUrl 또는 session.agentPortraitUrl —
 *   caller 부재 + profile picture 없을 때 fallback. 외부/상대 URL 모두 처리.
 * @param serverUrl 상대 URL prepend용. 없으면 상대 URL 도출 불가 → null.
 */
export function pickUserAvatarUri(
  caller: MessageCaller | null,
  profile: GoogleProfile | null,
  fallbackPortraitUrl: string | null | undefined,
  serverUrl: string | null,
): UserAvatarUriResult {
  // 1) 본인이 아닌 발신자 — caller.avatar_url만 신뢰
  if (caller) {
    const url = caller.avatar_url;
    if (url && url.length > 0) {
      if (url.startsWith('http')) {
        return { uri: url, useBearer: false };
      }
      if (!serverUrl) return { uri: null, useBearer: false };
      return {
        uri: `${serverUrl.replace(/\/$/, '')}${url}`,
        useBearer: true,
      };
    }
    // caller가 있는데 avatar_url 부재 — 본인 picture로 fallback하지 *않는다*.
    // 본인이 아닌 발신자에게 본인 아바타를 표시하는 것이 결함의 본질이었음.
    return { uri: null, useBearer: false };
  }

  // 2) 본인 발신 — PR #7 흐름 그대로
  if (profile?.picture && profile.picture.length > 0) {
    return { uri: profile.picture, useBearer: false };
  }
  if (!fallbackPortraitUrl || !serverUrl) {
    return { uri: null, useBearer: false };
  }
  if (fallbackPortraitUrl.startsWith('http')) {
    // 외부 URL은 Bearer 없이 로드 (CDN 정책 일관성).
    return { uri: fallbackPortraitUrl, useBearer: false };
  }
  return {
    uri: `${serverUrl.replace(/\/$/, '')}${fallbackPortraitUrl}`,
    useBearer: true,
  };
}

/**
 * fallback 글자 우선순위 (avatarUri가 null일 때 표시):
 *   caller.display_name?.[0] >
 *   caller.agent_name?.[0] >
 *   profile.name?.[0] >
 *   fallbackName?.[0] >
 *   defaultChar
 */
export function pickFallbackChar(
  caller: MessageCaller | null,
  profile: GoogleProfile | null,
  fallbackName: string | null | undefined,
  defaultChar: string,
): string {
  const fromCallerName = caller?.display_name?.[0];
  if (fromCallerName) return fromCallerName;
  const fromAgentName = caller?.agent_name?.[0];
  if (fromAgentName) return fromAgentName;
  const fromProfile = profile?.name?.[0];
  if (fromProfile) return fromProfile;
  const fromFallbackName = fallbackName?.[0];
  if (fromFallbackName) return fromFallbackName;
  return defaultChar;
}
