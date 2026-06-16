import { resolveCodexModelReasoningEffort } from "../codex_adapter.js";
import type { EngineExecuteParams } from "../protocol.js";
import { SOULSTREAM_AGENT_SESSION_HEADER } from "../../mcp/request_context.js";
import type {
  JsonObject,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
} from "./protocol.js";
import { toCodexUserInput } from "./protocol.js";

const SOULSTREAM_MCP_SERVER_NAME = "soulstream";

export function buildThreadStartParams(
  params: EngineExecuteParams,
  workspaceDir: string,
): ThreadStartParams {
  const model = normalizedModel(params.model);
  return {
    model,
    modelProvider: null,
    serviceTier: null,
    cwd: workspaceDir,
    runtimeWorkspaceRoots: [workspaceDir],
    approvalPolicy: "never",
    approvalsReviewer: null,
    sandbox: "danger-full-access",
    permissions: null,
    config: buildCodexMcpCallerSessionConfig(params.agentSessionId),
    serviceName: "soul-server-ts",
    baseInstructions: params.systemPrompt ?? null,
    developerInstructions: null,
    personality: null,
    ephemeral: false,
    sessionStartSource: "startup",
    threadSource: "user",
    environments: null,
    dynamicTools: null,
    mockExperimentalField: null,
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  };
}

export function buildThreadResumeParams(
  params: EngineExecuteParams,
  workspaceDir: string,
): ThreadResumeParams {
  return {
    threadId: params.resumeSessionId ?? "",
    history: null,
    path: null,
    model: normalizedModel(params.model),
    modelProvider: null,
    serviceTier: null,
    cwd: workspaceDir,
    runtimeWorkspaceRoots: [workspaceDir],
    approvalPolicy: "never",
    approvalsReviewer: null,
    sandbox: "danger-full-access",
    permissions: null,
    config: buildCodexMcpCallerSessionConfig(params.agentSessionId),
    baseInstructions: params.systemPrompt ?? null,
    developerInstructions: null,
    personality: null,
    excludeTurns: false,
    persistExtendedHistory: false,
  };
}

export function buildTurnStartParams(
  threadId: string,
  params: EngineExecuteParams,
  workspaceDir: string,
): TurnStartParams {
  const model = normalizedModel(params.model);
  return {
    threadId,
    input: toCodexUserInput({
      prompt: params.prompt,
      imageAttachmentPaths: params.imageAttachmentPaths,
    }),
    responsesapiClientMetadata: null,
    environments: null,
    cwd: workspaceDir,
    runtimeWorkspaceRoots: [workspaceDir],
    approvalPolicy: "never",
    approvalsReviewer: null,
    sandboxPolicy: { type: "dangerFullAccess" },
    permissions: null,
    model,
    serviceTier: null,
    effort: resolveCodexModelReasoningEffort(model, params.reasoningEffort) ?? null,
    summary: null,
    personality: null,
    outputSchema: null,
    collaborationMode: null,
  };
}

function normalizedModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  return trimmed ? trimmed : null;
}

function buildCodexMcpCallerSessionConfig(
  agentSessionId: string | undefined,
): JsonObject | null {
  const callerSessionId = agentSessionId?.trim();
  if (!callerSessionId) return null;
  return {
    mcp_servers: {
      [SOULSTREAM_MCP_SERVER_NAME]: {
        http_headers: {
          [SOULSTREAM_AGENT_SESSION_HEADER]: callerSessionId,
        },
      },
    },
  };
}
