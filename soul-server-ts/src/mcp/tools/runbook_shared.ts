import { z } from "zod";

import type { RunbookAssigneeInput } from "../../runbook/runbook_models.js";
import type { RunbookService } from "../../runbook/runbook_service.js";
import { SOULSTREAM_AGENT_SESSION_HEADER } from "../request_context.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

import { resolveEffectiveCallerSessionId } from "./caller_session.js";

export const runbookItemStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);
export const runbookStatusSchema = z.enum(["open", "completed"]);

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

type AssigneeToolInput = z.infer<typeof assigneeSchema>;

export async function mutation(
  runtime: McpRuntime,
  fn: (service: RunbookService, actorSessionId: string) => Promise<unknown>,
) {
  try {
    return jsonResult(await fn(getRunbookService(runtime), requireCallerSessionId()));
  } catch (err) {
    return errorResult(errorMessage(err));
  }
}

export function getRunbookService(runtime: McpRuntime): RunbookService {
  if (!runtime.runbookService) {
    throw new Error("runbook service is not configured");
  }
  return runtime.runbookService;
}

export function assigneePatch(input: { assignee?: AssigneeToolInput }):
  | { assignee?: RunbookAssigneeInput | null }
  | Record<string, never> {
  if (!Object.prototype.hasOwnProperty.call(input, "assignee")) return {};
  return { assignee: toAssignee(input.assignee ?? null) };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireCallerSessionId(): string {
  const callerSessionId = resolveEffectiveCallerSessionId(undefined);
  if (!callerSessionId) {
    throw new Error(
      `caller session id is required for runbook mutation tools. Send ${SOULSTREAM_AGENT_SESSION_HEADER}.`,
    );
  }
  return callerSessionId;
}

function toAssignee(input: AssigneeToolInput): RunbookAssigneeInput | null {
  if (!input) return null;
  return {
    kind: input.kind,
    agentId: input.agent_id,
    sessionId: input.session_id,
    userId: input.user_id,
  };
}
