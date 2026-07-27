import type { ResolvedMcpServer } from "../../mcp_config_service.js";
import { resolveCodexModelReasoningEffort } from "../codex_adapter.js";
import type { EngineExecuteParams } from "../protocol.js";
import type {
  JsonObject,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
} from "./protocol.js";
import { toCodexUserInput } from "./protocol.js";

export function buildThreadStartParams(
  params: EngineExecuteParams,
  workspaceDir: string,
  resolvedMcpServers?: ResolvedMcpServer[],
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
    config: buildCodexMcpConfig(resolvedMcpServers),
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
  resolvedMcpServers?: ResolvedMcpServer[],
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
    config: buildCodexMcpConfig(resolvedMcpServers),
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

export function selectCodexMcpServers(
  servers: ResolvedMcpServer[] | undefined,
): {
  supportedServers: ResolvedMcpServer[] | undefined;
  skippedSseServers: ResolvedMcpServer[];
} {
  if (servers === undefined) {
    return {
      supportedServers: undefined,
      skippedSseServers: [],
    };
  }

  const supportedServers: ResolvedMcpServer[] = [];
  const skippedSseServers: ResolvedMcpServer[] = [];
  for (const server of servers) {
    if (server.type === "sse") {
      skippedSseServers.push(server);
    } else {
      supportedServers.push(server);
    }
  }
  return { supportedServers, skippedSseServers };
}

function normalizedModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  return trimmed ? trimmed : null;
}

function buildCodexMcpConfig(
  servers: ResolvedMcpServer[] | undefined,
): JsonObject | null {
  const { supportedServers } = selectCodexMcpServers(servers);
  if (supportedServers === undefined) return null;

  const mcpServers: JsonObject = {};
  for (const server of supportedServers) {
    const name = server.name?.trim();
    if (!name) {
      throw new Error("Resolved MCP profile server requires a name");
    }
    if (mcpServers[name]) {
      throw new Error(`Codex MCP profile contains duplicate server name: ${name}`);
    }

    if (server.type === "stdio") {
      if (!server.command) {
        throw new Error(
          `Codex MCP stdio server ${name} requires command; full_command is unsupported`,
        );
      }
      mcpServers[name] = {
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        enabled: true,
      };
      continue;
    }

    mcpServers[name] = {
      url: server.url,
      ...(server.headers ? { http_headers: server.headers } : {}),
      enabled: true,
    };
  }
  return { mcp_servers: mcpServers };
}
