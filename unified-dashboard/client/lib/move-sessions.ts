/**
 * 세션 이동 낙관적 업데이트 (unified-dashboard)
 *
 * soul-ui의 createMoveSessionsOperations 팩토리를 사용하여
 * worker/orchestrator 공통 API 경로에 바인딩한다.
 */

import { createMoveSessionsOperations } from "@seosoyoung/soul-ui";

export const { moveSessionsOptimistic } = createMoveSessionsOperations({
  singleUrl: (id) => `/api/sessions/${id}`,
  singleMethod: "PUT",
  batchUrl: "/api/sessions/folder",
  batchMethod: "PATCH",
});

/** The server expands roots and commits their descendants and assigned cards together. */
export async function moveSessionTree(sessionId:string,folderId:string):Promise<string[]> {
  const response=await fetch("/api/sessions/folder",{
    method:"PATCH",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({sessionIds:[sessionId],folderId}),
  });
  if(!response.ok) throw new Error(`세션 이동에 실패했습니다 (${response.status}).`);
  const result=await response.json() as {sessionIds:string[]};
  return result.sessionIds;
}
