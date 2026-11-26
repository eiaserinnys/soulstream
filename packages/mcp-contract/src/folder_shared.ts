import { z } from "zod";

export const CALLER_SESSION_ID_FALLBACK_GUIDANCE =
  "세션 헤더를 전달할 수 없는 신뢰된 내부 클라이언트만 자기 agent_session_id를 caller_session_id로 전달한다.";

/** expected_version과 idempotency_key를 받는 카드 도구의 설명이 같은 말로 안내하도록 한 곳에 둔다. */
export const EXPECTED_VERSION_HINT =
  "expected_version에는 get_card 응답의 card.version 값을 넣는다. 다른 세션이 먼저 카드를 바꿔 판이 달라졌다는 거절이 나면 get_card로 다시 읽고 새 값으로 한 번 더 부른다.";
export const IDEMPOTENCY_KEY_HINT =
  "idempotency_key에는 임의 문자열을 넣고, 같은 요청을 다시 보낼 때는 같은 값을 쓴다.";

export const folderStatusSchema = z.enum(["open", "completed"]);
export const assigneeValueSchema = z.object({
  kind: z.enum(["agent", "human", "session"]),
  agent_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
}).nullable();
export type FolderStatus = z.infer<typeof folderStatusSchema>;
export type CardAssigneeKind = NonNullable<z.infer<typeof assigneeValueSchema>>["kind"];
export type FolderOperationActorKind = "agent" | "user" | "system" | "llm";
export type FolderCompletionKind = Exclude<FolderOperationActorKind, "system">;

export const assigneeSchema = assigneeValueSchema.optional();
export const idempotencyKeySchema = z.string().min(1);
export const optionalReasonSchema = z.string().nullable().optional();
export const expectedVersionSchema = z.number().int().positive();
export const callerSessionIdSchema = z.string().optional();
export function mutationToolDescription(description: string): string {
  return `${description} 변경 결과는 폴더 또는 카드와 operation을 반환한다. 전체 카드 목록은 get_folder로 조회한다. ${CALLER_SESSION_ID_FALLBACK_GUIDANCE}`;
}
