/**
 * SessionMetadata 렌더링용 순수 헬퍼.
 *
 * 컴포넌트 렌더 로직과 분리된 데이터 변환 함수를 모아 단위 테스트(.test.ts)에서
 * 검증한다. 컴포넌트 렌더 테스트는 vitest 환경(node)에서 별도 의존성 없이는
 * 실행할 수 없으므로, 분기 로직과 키 생성을 함수 단위로 추출하여 검증한다.
 */

import { formatUserId } from "./caller-avatar-helpers";

/**
 * file_write/file_edit 같은 dedup 키, JSX key prop 모두에 사용.
 * value가 객체면 JSON.stringify로 안정적인 key를 만든다.
 */
export function getDedupKey(value: string | Record<string, unknown>): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export interface CallerInfoLine {
  label: string;
  text: string;
}

/**
 * caller_info 메타데이터 객체에서 표시 가능한 라벨/텍스트 줄을 추출한다.
 *
 * 통합 스키마 v1 (2026-05-07 Plan A·B·C 합의):
 *  - top-level: source, display_name, user_id, avatar_url, email
 *  - sub-dict slack: {channel_id, user_id, thread_ts}
 *  - 기존 필드(agent_node, agent_id, agent_name, parent_session_id, ip 등) 보존
 *
 * 알려진 필드만 라벨화하고, 빈 객체에서는 source: "unknown" 한 줄만 반환.
 *
 * 라벨 순서: source → name → id → email → parent → node → agent → ip → channel
 */
export function buildCallerInfoLines(
  value: Record<string, unknown>,
  callerSessionId?: string | null,
): CallerInfoLine[] {
  const source = String(value.source ?? "unknown");
  const lines: CallerInfoLine[] = [
    { label: "source", text: source },
  ];

  // 통합 스키마 v1 top-level 신원 — 통합 표시
  if (value.display_name) {
    lines.push({ label: "name", text: String(value.display_name) });
  }
  if (value.user_id) {
    lines.push({ label: "id", text: formatUserId(String(value.user_id), source) });
  }
  if (value.email) {
    // browser/soul-app의 경우 user_id == email로 의도적 중복 — 별 라벨로 명시 표시
    lines.push({ label: "email", text: String(value.email) });
  }

  // parent (1급 callerSessionId가 우선)
  const parentId = callerSessionId ?? value.parent_session_id;
  if (parentId) {
    lines.push({ label: "parent", text: String(parentId).slice(0, 8) });
  }

  // agent 컨텍스트
  if (value.agent_node) {
    lines.push({ label: "node", text: String(value.agent_node) });
  }
  // agent 라벨은 source='agent'에서 display_name이 없을 때만 보조 표시
  // (display_name이 있으면 이미 'name' 라벨로 표시되어 중복 방지)
  if (!value.display_name && (value.agent_name || value.agent_id)) {
    lines.push({
      label: "agent",
      text: String(value.agent_name ?? value.agent_id),
    });
  }

  // HTTP 메타
  if (value.ip) {
    lines.push({ label: "ip", text: String(value.ip) });
  }

  // slack channel: sub-dict 우선 (통합 스키마 v1), top-level fallback (legacy 데이터)
  const slackSub =
    value.slack && typeof value.slack === "object" && !Array.isArray(value.slack)
      ? (value.slack as Record<string, unknown>)
      : null;
  const channelId = slackSub?.channel_id ?? value.channel_id;
  if (channelId) {
    lines.push({ label: "channel", text: String(channelId) });
  }

  return lines;
}
