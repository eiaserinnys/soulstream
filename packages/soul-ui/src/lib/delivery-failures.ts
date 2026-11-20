/**
 * 카드 #1524: 사람이 보낸 글이 전달 장부에서 dead_letter로 닫힌 목록.
 *
 * 서버는 그 세션의 human_live_steer 실패 행을 최신순 최대 100개로 돌려준다.
 * 말풍선 이벤트의 input_id와 맞춰 그 말풍선에 실패 표시를 켠다.
 */

export interface DeliveryFailureRow {
  input_id: string;
  reason: string | null;
  failed_at: string | null;
}

export async function fetchDeliveryFailures(
  sessionId: string,
): Promise<Record<string, string>> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/delivery-failures`,
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new Error(`delivery failures: HTTP ${response.status}`);
  }
  const rows = await response.json() as unknown;
  if (!Array.isArray(rows)) {
    throw new Error("delivery failures: unexpected payload");
  }
  const failures: Record<string, string> = {};
  for (const raw of rows) {
    if (raw === null || typeof raw !== "object") continue;
    const row = raw as Partial<DeliveryFailureRow>;
    if (typeof row.input_id !== "string" || row.input_id.length === 0) continue;
    failures[row.input_id] = typeof row.reason === "string" ? row.reason : "";
  }
  return failures;
}
