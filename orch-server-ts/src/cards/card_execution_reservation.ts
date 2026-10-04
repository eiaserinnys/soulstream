import type { RepositorySql } from "./control_plane/card_types.js";
export async function assertNoPendingCardExecution(sql:RepositorySql,cardId:string) {
  if ((await sql`SELECT id FROM card_execution_requests WHERE card_id=${cardId} AND state='pending' LIMIT 1`).length)
    throw Object.assign(new Error("실행 결과 확인 중입니다. 같은 요청의 결과를 확인하세요."),{statusCode:409,code:"CARD_EXECUTION_PENDING"});
}
