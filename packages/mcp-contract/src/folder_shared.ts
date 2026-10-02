import { z } from "zod";

export const CALLER_SESSION_ID_FALLBACK_GUIDANCE =
  "세션 헤더를 전달할 수 없는 신뢰된 내부 클라이언트만 자기 agent_session_id를 caller_session_id로 전달한다.";

export const folderStatusSchema = z.enum(["open", "completed"]);
export const assigneeValueSchema = z.object({
  kind: z.enum(["agent", "human", "session"]),
  agent_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
}).nullable();
export const assigneeSchema = assigneeValueSchema.optional();
export const idempotencyKeySchema = z.string().min(1);
export const optionalReasonSchema = z.string().nullable().optional();
export const expectedVersionSchema = z.number().int().positive();
export const callerSessionIdSchema = z.string().optional();
export function mutationToolDescription(description: string): string {
  return `${description} 변경 결과는 폴더 또는 카드와 operation을 반환한다. 전체 카드 목록은 get_folder로 조회한다. ${CALLER_SESSION_ID_FALLBACK_GUIDANCE}`;
}
