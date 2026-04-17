/**
 * Cursor Codec (Phase 3 viewport API)
 *
 * 서버 `/sessions/{id}/messages` 엔드포인트의 커서 페이지네이션 포맷을 인코딩/디코딩한다.
 *
 * 포맷: `${ISO8601_timestamp},${event_id}`
 * - ISO8601 타임스탬프는 `,`를 포함하지 않으므로 **마지막 comma**를 기준으로 split한다.
 * - event_id는 단조증가하는 BIGINT.
 *
 * 설계 결정:
 * - 클라이언트가 서버 응답의 `next_before_cursor`를 그대로 사용하는 것이 정본이며,
 *   이 코덱은 단위 테스트와 디버깅, 그리고 초기 커서 생성(타임스탬프+event_id에서)에만 사용한다.
 */

/** cursor 문자열을 {timestamp, eventId}로 분해한다 */
export function decodeCursor(cursor: string): { timestamp: string; eventId: number } {
  const lastComma = cursor.lastIndexOf(",");
  if (lastComma < 0) {
    throw new Error(`Invalid cursor: missing comma separator: ${cursor}`);
  }
  const timestamp = cursor.slice(0, lastComma);
  const eventIdStr = cursor.slice(lastComma + 1);
  const eventId = Number(eventIdStr);
  if (!Number.isFinite(eventId) || !Number.isInteger(eventId) || eventId < 0) {
    throw new Error(`Invalid cursor event_id: ${eventIdStr}`);
  }
  if (!timestamp) {
    throw new Error(`Invalid cursor: empty timestamp: ${cursor}`);
  }
  return { timestamp, eventId };
}

/** {timestamp, eventId}를 cursor 문자열로 조립한다 */
export function encodeCursor(timestamp: string, eventId: number): string {
  if (!timestamp) throw new Error("encodeCursor: timestamp is empty");
  if (!Number.isFinite(eventId) || !Number.isInteger(eventId) || eventId < 0) {
    throw new Error(`encodeCursor: invalid eventId: ${eventId}`);
  }
  return `${timestamp},${eventId}`;
}
