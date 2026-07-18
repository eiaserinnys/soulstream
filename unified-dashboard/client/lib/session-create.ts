import type { QueryClient } from "@tanstack/react-query";
import type {
  BoardContainerRef,
  CreateSessionRequest,
  CreateSessionResponse,
  ReasoningEffort,
} from "@seosoyoung/soul-ui";

import { HttpResponseError } from "./http-response-error";

export interface SessionAgentMetadata {
  id?: string | null;
  name?: string | null;
  portraitUrl?: string | null;
  backend?: string | null;
}

export type AddOptimisticSession = (
  queryClient: QueryClient,
  agentSessionId: string,
  prompt: string,
  folderId?: string | null,
  nodeId?: string,
  agentId?: string | null,
  agentName?: string | null,
  agentPortraitUrl?: string | null,
  backend?: string | null,
  boardPosition?: { x: number; y: number } | null,
) => void;

export interface CreateDashboardSessionInput {
  queryClient: QueryClient;
  addOptimisticSession: AddOptimisticSession;
  prompt?: string;
  initialInstruction?: string;
  attachmentPaths?: string[];
  folderId?: string | null;
  nodeId?: string;
  agentId?: string | null;
  agent?: SessionAgentMetadata | null;
  reasoningEffort?: ReasoningEffort | null;
  oauthProfileName?: string | null;
  container?: BoardContainerRef | null;
  sourceSessionId?: string | null;
  sourceRunbookItemId?: string | null;
  boardPosition?: { x: number; y: number } | null;
  agentSessionId?: string;
  pageAnchor?: { pageId: string; blockId: string; expectedVersion: number };
  predecessorSessionId?: string | null;
  contextItems?: Array<{ key: string; label?: string; content: unknown }>;
}

export async function createDashboardSession(
  input: CreateDashboardSessionInput,
): Promise<CreateSessionResponse> {
  if (input.prompt === undefined && input.initialInstruction === undefined) {
    throw new Error("prompt or initialInstruction is required");
  }
  const payload: CreateSessionRequest & { predecessor_session_id?: string } = {
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.initialInstruction !== undefined
      ? { initial_instruction: input.initialInstruction }
      : {}),
    ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
    ...(input.pageAnchor ? { pageAnchor: input.pageAnchor } : {}),
    ...(input.predecessorSessionId ? { predecessor_session_id: input.predecessorSessionId } : {}),
    ...(input.contextItems?.length ? { extra_context_items: input.contextItems } : {}),
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.attachmentPaths?.length ? { attachmentPaths: input.attachmentPaths } : {}),
    ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
    ...(input.container ? { container: input.container } : {}),
    ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
    ...(input.sourceRunbookItemId !== undefined
      ? { sourceRunbookItemId: input.sourceRunbookItemId }
      : {}),
    ...(input.agentId ? { profile: input.agentId } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.oauthProfileName ? { oauth_profile_name: input.oauthProfileName } : {}),
  };

  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new HttpResponseError(await readSessionCreateError(response), response.status);
  }

  let result: CreateSessionResponse;
  try {
    result = await response.json();
  } catch {
    throw new Error("Server returned an invalid response");
  }

  const optimisticPrompt = result.prompt ?? input.prompt;
  if (optimisticPrompt === undefined) {
    throw new Error("Server response is missing the assembled prompt");
  }

  input.addOptimisticSession(
    input.queryClient,
    result.agentSessionId,
    optimisticPrompt,
    input.folderId ?? null,
    result.nodeId ?? input.nodeId,
    input.agentId || null,
    input.agent?.name ?? null,
    input.agent?.portraitUrl ?? null,
    input.agent?.backend ?? null,
    input.container?.kind === "runbook" ? null : input.boardPosition ?? null,
  );

  return result;
}

async function readSessionCreateError(response: Response): Promise<string> {
  let errorMessage = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (typeof body?.detail === "string") return body.detail;
    if (typeof body?.error?.message === "string") return body.error.message;
    if (typeof body?.error === "string") return body.error;
  } catch {
    errorMessage = `Server error (${response.status})`;
  }
  return errorMessage;
}
