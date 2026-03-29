/**
 * 오케스트레이터 전용 세션 이름 변경 낙관적 업데이트
 *
 * soulstream-server의 PATCH /api/sessions/{session_id}/display-name 엔드포인트를 사용한다.
 */

import { createRenameSessionOperation } from "@seosoyoung/soul-ui";

export const { renameSessionOptimistic } = createRenameSessionOperation({
  url: (sessionId) => `/api/sessions/${sessionId}/display-name`,
  method: "PATCH",
});
