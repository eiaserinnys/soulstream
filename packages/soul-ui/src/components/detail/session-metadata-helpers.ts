/**
 * SessionMetadata 렌더링용 순수 헬퍼.
 *
 * 컴포넌트 렌더 로직과 분리된 데이터 변환 함수를 모아 단위 테스트(.test.ts)에서
 * 검증한다. 컴포넌트 렌더 테스트는 vitest 환경(node)에서 별도 의존성 없이는
 * 실행할 수 없으므로, 분기 로직과 키 생성을 함수 단위로 추출하여 검증한다.
 */

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
 * 서버 측 source 종류:
 *  - `slack` — channel_id, user_id 등
 *  - `browser` — ip, referer 등
 *  - `agent` — parent_session_id, agent_node, agent_id, agent_name
 *  - `api` — ip, user_agent
 *
 * 알려진 필드만 라벨화하고, 빈 객체에서는 source: "unknown" 한 줄만 반환.
 */
export function buildCallerInfoLines(value: Record<string, unknown>): CallerInfoLine[] {
  const lines: CallerInfoLine[] = [
    { label: "source", text: String(value.source ?? "unknown") },
  ];
  if (value.parent_session_id) {
    lines.push({
      label: "parent",
      text: String(value.parent_session_id).slice(0, 8),
    });
  }
  if (value.agent_node) {
    lines.push({ label: "node", text: String(value.agent_node) });
  }
  if (value.agent_name || value.agent_id) {
    lines.push({
      label: "agent",
      text: String(value.agent_name ?? value.agent_id),
    });
  }
  if (value.ip) {
    lines.push({ label: "ip", text: String(value.ip) });
  }
  if (value.channel_id) {
    lines.push({ label: "channel", text: String(value.channel_id) });
  }
  return lines;
}
