/**
 * 세션 이동 낙관적 업데이트 (unified-dashboard)
 *
 * soul-ui의 createMoveSessionsOperations 팩토리를 사용하여
 * soul-server API 경로에 바인딩한다.
 */

import { createMoveSessionsOperations } from "@seosoyoung/soul-ui";

export const { moveSessionsOptimistic } = createMoveSessionsOperations({
  singleUrl: (id) => `/api/catalog/sessions/${id}`,
  singleMethod: "PUT",
  batchUrl: "/api/catalog/sessions/batch",
  batchMethod: "PUT",
});
