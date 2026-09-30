import { z } from "zod";

import type { CardAssigneeInput } from "../../folder/folder_models.js";
import type { FolderService } from "../../folder/folder_service.js";
import { errorResultFromError, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import {
  CALLER_SESSION_ID_FALLBACK_GUIDANCE,
  requireMcpMutationActor,
  type McpMutationActor,
} from "./caller_session.js";
import type { FolderMutationResult } from "../../folder/folder_service_models.js";

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
  return `${description} 변경 결과는 폴더 또는 카드과 operation을 반환한다. 전체 카드 목록는 get_folder로 조회한다. ${CALLER_SESSION_ID_FALLBACK_GUIDANCE}`;
}

export async function mutation(
  runtime: McpRuntime,
  explicitCallerSessionId: string | null | undefined,
  fn: (service: FolderService, actor: McpMutationActor) => Promise<FolderMutationResult>,
) {
  try {
    const result = await fn(getFolderService(runtime), requireMcpMutationActor(explicitCallerSessionId, "folder mutation tools"));
    return jsonResult(result);
  } catch (err) {
    return errorResultFromError(err);
  }
}

export function getFolderService(runtime: McpRuntime): FolderService {
  if (!runtime.folderService) throw new Error("folder service is not configured");
  return runtime.folderService;
}

export function assigneePatch(input: { assignee?: z.infer<typeof assigneeSchema> }): { assignee?: CardAssigneeInput | null } | Record<string, never> {
  if (!Object.prototype.hasOwnProperty.call(input, "assignee")) return {};
  if (!input.assignee) return { assignee: null };
  return { assignee: {
    kind: input.assignee.kind,
    agentId: input.assignee.agent_id,
    sessionId: input.assignee.session_id,
    userId: input.assignee.user_id,
  } };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
