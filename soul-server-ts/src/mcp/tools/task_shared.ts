import { z } from "zod";

import type { TaskAssigneeInput } from "../../work-task/task_models.js";
import type { TaskService } from "../../work-task/task_service.js";
import type { TaskOperationTargetKind } from "../../db/session_db_types.js";
import { SOULSTREAM_AGENT_SESSION_HEADER } from "../request_context.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

import { resolveEffectiveCallerSessionId } from "./caller_session.js";
import {
  formatTaskMutationResponse,
  type TaskMutationEnvelope,
} from "./task_response.js";

export const taskItemStatusSchema = z.enum([
  "pending",
  "in_progress",
  "review",
  "completed",
  "cancelled",
]);
export const taskStatusSchema = z.enum(["open", "completed"]);

export const assigneeValueSchema = z
  .object({
    kind: z.enum(["agent", "human", "session"]),
    agent_id: z.string().nullable().optional(),
    session_id: z.string().nullable().optional(),
    user_id: z.string().nullable().optional(),
  })
  .nullable();

export const assigneeSchema = assigneeValueSchema.optional();
export const idempotencyKeySchema = z.string().min(1);
export const optionalReasonSchema = z.string().nullable().optional();
export const expectedVersionSchema = z.number().int().positive();
export const callerSessionIdSchema = z.string().optional();
export const mutationResponseInputSchema = {
  include_snapshot: z.boolean().default(false),
};
export const CALLER_SESSION_ID_GUIDANCE =
  "Codex 등 헤더 미지원 백엔드는 자기 agent_session_id를 caller_session_id로 전달한다.";

type AssigneeToolInput = z.infer<typeof assigneeSchema>;

export function mutationToolDescription(description: string): string {
  return `${description} 기본 응답은 operation, 변경된 target row, task 헤더만 반환한다. 전체 snapshot이 필요하면 include_snapshot=true를 사용한다. ${CALLER_SESSION_ID_GUIDANCE}`;
}

export async function mutation(
  runtime: McpRuntime,
  explicitCallerSessionId: string | null | undefined,
  fn: (
    service: TaskService,
    actorSessionId: string,
  ) => Promise<TaskMutationEnvelope>,
  options: {
    targetKind: TaskOperationTargetKind;
    includeSnapshot: boolean;
  },
) {
  try {
    const result = await fn(
      getTaskService(runtime),
      requireCallerSessionId(explicitCallerSessionId),
    );
    return jsonResult(
      formatTaskMutationResponse(
        result,
        options.targetKind,
        options.includeSnapshot,
      ),
    );
  } catch (err) {
    return errorResult(errorMessage(err));
  }
}

export function getTaskService(runtime: McpRuntime): TaskService {
  if (!runtime.taskService) {
    throw new Error("task service is not configured");
  }
  return runtime.taskService;
}

export function assigneePatch(input: {
  assignee?: AssigneeToolInput;
}): { assignee?: TaskAssigneeInput | null } | Record<string, never> {
  if (!Object.prototype.hasOwnProperty.call(input, "assignee")) return {};
  return { assignee: toAssignee(input.assignee ?? null) };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireCallerSessionId(
  explicitCallerSessionId: string | null | undefined,
): string {
  const callerSessionId = resolveEffectiveCallerSessionId(
    explicitCallerSessionId,
  );
  if (!callerSessionId) {
    throw new Error(
      `caller session id is required for task mutation tools. Send ${SOULSTREAM_AGENT_SESSION_HEADER}.`,
    );
  }
  return callerSessionId;
}

function toAssignee(input: AssigneeToolInput): TaskAssigneeInput | null {
  if (!input) return null;
  return {
    kind: input.kind,
    agentId: input.agent_id,
    sessionId: input.session_id,
    userId: input.user_id,
  };
}
