import type { Session } from '../api/types';

/**
 * 세션의 표시명을 결정하는 폴백 로직 정본.
 *
 * 우선순위:
 *   1. session.displayName (사용자/서버가 설정한 이름)
 *   2. session.lastMessage.preview 첫 줄 (이름 미설정 시 마지막 메시지로 식별)
 *   3. "제목 없는 세션" (UUID를 사용자 제목으로 노출하지 않음)
 *
 * 호출처:
 *   - SessionCard (피드/리스트의 세션 카드)
 *   - ChatScreen (폰 채팅 화면 헤더)
 *   - ChatPane (태블릿 split 채팅 패널 인라인 헤더)
 *
 * 세 호출처 모두 동일한 `useSessionStore().sessions[id]` 객체를 사용하므로
 * 모양 차이로 인한 보정이 필요 없다. 다만 ChatScreen/ChatPane은 catalog 응답이
 * 도착하기 전 짧은 순간 `session`이 undefined일 수 있어, 그 경우의 폴백을 위해
 * 호환 호출 시그니처를 위해 route param의 sessionId를 받지만 화면 제목에는 노출하지 않는다.
 *
 * Phase A-bis(2026-05-16): Session 타입 camelCase 통일 — display_name → displayName,
 * last_message → lastMessage.
 */
export function getSessionDisplayName(
  session: Session | undefined,
  _fallbackId: string,
): string {
  if (session?.displayName) return session.displayName;
  const previewLine = session?.lastMessage?.preview?.split('\n')[0]?.trim();
  if (previewLine && previewLine.length > 0) return previewLine;
  return '제목 없는 세션';
}
