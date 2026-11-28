import { adminTranslation, type AdminTranslate } from "../components/config/admin-translation";
import { createMoveSessionsOperations } from "@seosoyoung/soul-ui";

export const { moveSessionsOptimistic } = createMoveSessionsOperations({
  singleUrl: (id) => `/api/sessions/${id}`,
  singleMethod: "PUT",
  batchUrl: "/api/sessions/folder",
  batchMethod: "PATCH",
});

/** The server expands roots and commits their descendants and assigned cards together. */
export async function moveSessionTree(sessionId: string, folderId: string, t?: AdminTranslate):Promise<string[]> {
  const response=await fetch("/api/sessions/folder",{
    method:"PATCH",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({sessionIds:[sessionId],folderId}),
  });
  if(!response.ok) throw new Error((t ?? adminTranslation())("admin.session.moveError", { status: response.status }));
  const result=await response.json() as {sessionIds:string[]};
  return result.sessionIds;
}
