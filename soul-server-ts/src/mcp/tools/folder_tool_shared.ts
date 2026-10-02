import { z } from "zod";

import type { CardAssigneeInput } from "../../folder/folder_models.js";
import type { FolderService } from "../../folder/folder_service.js";
import { errorResultFromError, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import {
  requireMcpMutationActor,
  type McpMutationActor,
} from "./caller_session.js";
import type { FolderMutationResult } from "../../folder/folder_service_models.js";

export { folderStatusSchema, assigneeValueSchema, assigneeSchema, idempotencyKeySchema, optionalReasonSchema, expectedVersionSchema, callerSessionIdSchema, mutationToolDescription } from "@soulstream/mcp-contract";
import { assigneeSchema } from "@soulstream/mcp-contract";

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
