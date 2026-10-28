import type { FastifyInstance, FastifyReply } from "fastify";

import type { NodeCommandResponse, RequestResponseNodeCommandPayload } from "./pending_commands.js";
import type { InMemoryNodeRegistry } from "./registry.js";
import { supportsClaudeAccountPool } from "./registry_helpers.js";
import type { SessionCommandTransportBridge } from "../session/session_command_transport.js";
import type { UsageSummaryService } from "../usage/usage_summary_service.js";

export type ClaudeAccountPoolRouteOptions = {
  readonly registry: InMemoryNodeRegistry;
  readonly bridge: SessionCommandTransportBridge;
  readonly usageSummary: Pick<UsageSummaryService, "refreshNode">;
  readonly timeoutMs?: number;
};

export const claudeAccountPoolRouteAuthRequirements = {
  "GET /api/nodes/:node_id/claude-auth/accounts": true,
  "PATCH /api/nodes/:node_id/claude-auth/accounts/:id": true,
  "DELETE /api/nodes/:node_id/claude-auth/accounts/:id": true,
  "POST /api/nodes/:node_id/claude-auth/logins": true,
  "GET /api/nodes/:node_id/claude-auth/logins/:login_id": true,
  "POST /api/nodes/:node_id/claude-auth/logins/:login_id/code": true,
  "DELETE /api/nodes/:node_id/claude-auth/logins/:login_id": true,
} as const;

type NodeParams = { node_id: string };
type AccountParams = NodeParams & { id: string };
type LoginParams = NodeParams & { login_id: string };
type PoolCommandResult = NodeCommandResponse & { success?: unknown; data?: unknown; error?: unknown };
type SuccessAction = "account_list" | "account_delete" | "login_flow" | "login_flow_done";

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerClaudeAccountPoolRoutes(
  app: FastifyInstance,
  options: ClaudeAccountPoolRouteOptions,
): void {
  app.get<{ Params: NodeParams }>(
    "/api/nodes/:node_id/claude-auth/accounts",
    async (request, reply) => sendPoolCommand(
      reply,
      options,
      request.params.node_id,
      { type: "claude_auth_accounts_list" },
      { successAction: "account_list" },
    ),
  );

  app.patch<{ Params: AccountParams; Body: unknown }>(
    "/api/nodes/:node_id/claude-auth/accounts/:id",
    async (request, reply) => {
      const accountId = accountIdOrError(reply, request.params.id);
      if (accountId === undefined) return reply;
      const patch = parseAccountPatch(request.body);
      if (patch === null) return sendPoolError(reply, 400, "invalid_request", "Invalid Claude account update.");
      return sendPoolCommand(
        reply,
        options,
        request.params.node_id,
        { type: "claude_auth_account_update", account_id: accountId, ...patch },
        { successAction: "account_list", refresh: true },
      );
    },
  );

  app.delete<{ Params: AccountParams }>(
    "/api/nodes/:node_id/claude-auth/accounts/:id",
    async (request, reply) => {
      const accountId = accountIdOrError(reply, request.params.id);
      if (accountId === undefined) return reply;
      return sendPoolCommand(
        reply,
        options,
        request.params.node_id,
        { type: "claude_auth_account_delete", account_id: accountId },
        { successAction: "account_delete", refresh: true },
      );
    },
  );

  app.post<{ Params: NodeParams; Body: unknown }>(
    "/api/nodes/:node_id/claude-auth/logins",
    async (request, reply) => {
      const accountId = parseLoginStartBody(request.body);
      if (accountId === undefined) return sendPoolError(reply, 400, "invalid_request", "Invalid Claude login request.");
      return sendPoolCommand(
        reply,
        options,
        request.params.node_id,
        {
          type: "claude_auth_login_start",
          ...(accountId === null ? {} : { account_id: accountId }),
        },
        { successAction: "login_flow", successStatus: 202 },
      );
    },
  );

  app.get<{ Params: LoginParams }>(
    "/api/nodes/:node_id/claude-auth/logins/:login_id",
    async (request, reply) => sendPoolCommand(
      reply,
      options,
      request.params.node_id,
      { type: "claude_auth_login_status", login_id: request.params.login_id },
      { successAction: "login_flow_done", refresh: true },
    ),
  );

  app.post<{ Params: LoginParams; Body: unknown }>(
    "/api/nodes/:node_id/claude-auth/logins/:login_id/code",
    async (request, reply) => {
      const code = parseLoginCode(request.body);
      if (code === null) return sendPoolError(reply, 400, "invalid_request", "Invalid Claude login code.");
      return sendPoolCommand(
        reply,
        options,
        request.params.node_id,
        {
          type: "claude_auth_login_submit_code",
          login_id: request.params.login_id,
          code,
        },
        { successAction: "login_flow_done", refresh: true },
      );
    },
  );

  app.delete<{ Params: LoginParams }>(
    "/api/nodes/:node_id/claude-auth/logins/:login_id",
    async (request, reply) => sendPoolCommand(
      reply,
      options,
      request.params.node_id,
      { type: "claude_auth_login_cancel", login_id: request.params.login_id },
      { successAction: "login_flow", refresh: false },
    ),
  );
}

export function sendClaudeAccountPoolAccountsAlias(
  reply: FastifyReply,
  options: ClaudeAccountPoolRouteOptions,
  nodeId: string,
): Promise<FastifyReply> {
  return sendPoolCommand(
    reply,
    options,
    nodeId,
    { type: "claude_auth_accounts_list" },
    { successAction: "account_list" },
  );
}

async function sendPoolCommand(
  reply: FastifyReply,
  options: ClaudeAccountPoolRouteOptions,
  nodeId: string,
  payload: RequestResponseNodeCommandPayload,
  action: {
    readonly successAction: SuccessAction;
    readonly successStatus?: number;
    readonly refresh?: boolean;
  },
): Promise<FastifyReply> {
  const node = options.registry.getConnectedNode(nodeId);
  if (node === undefined) return sendPoolError(reply, 404, "node_not_connected", "Node is not connected.");
  if (!supportsClaudeAccountPool(node.capabilities)) {
    return sendPoolError(reply, 409, "claude_account_pool_unsupported", "Node does not support Claude account pools.");
  }

  try {
    const command = options.registry.createCommand(nodeId, payload, { timeoutMs: options.timeoutMs });
    const response = await options.bridge.sendPendingCommand({ node, command }) as PoolCommandResult;
    if (response.success !== true) return sendNodeRejection(reply, response);

    const flowDone = action.successAction === "login_flow_done" && loginFlowIsDone(response.data);
    const shouldRefresh = action.refresh === true && (
      action.successAction !== "login_flow_done" || flowDone
    );
    const refreshedList = shouldRefresh
      ? accountListFromSummary(await options.usageSummary.refreshNode(nodeId), nodeId)
      : null;
    const data = action.successAction === "account_list"
      ? refreshedList ?? response.data
      : action.successAction === "account_delete" && refreshedList !== null
        ? mergeDeleteResult(response.data, refreshedList)
        : response.data;
    return reply.code(action.successStatus ?? 200).send(data);
  } catch (error) {
    const code = error instanceof Error && error.name === "PendingNodeCommandTimeoutError"
      ? "node_command_timeout"
      : "node_command_failed";
    return sendPoolError(reply, 502, code, "Claude account node request failed.");
  }
}

function sendNodeRejection(reply: FastifyReply, response: PoolCommandResult): FastifyReply {
  const workerError = isRecord(response.error) ? response.error : null;
  const code = safeErrorCode(workerError?.code);
  const status = code === "account_exists" || code === "account_identity_mismatch"
    || code === "login_flow_required" || code === "login_in_progress"
    ? 409
    : code.endsWith("_not_found") ? 404 : 400;
  const body: Record<string, unknown> = { code, message: errorMessage(code) };
  if (code === "account_exists" && isAccountId(workerError?.existing_account_id)) {
    body.existing_account_id = workerError.existing_account_id;
  }
  return reply.code(status).send(body);
}

function sendPoolError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ code, message });
}

function errorMessage(code: string): string {
  switch (code) {
    case "account_exists": return "Claude account already exists.";
    case "account_identity_mismatch": return "The authenticated Claude account did not match.";
    case "account_not_found": return "Claude account not found.";
    case "login_not_found": return "Claude login flow not found.";
    case "login_flow_required": return "Use the Claude account login flow.";
    case "login_in_progress": return "A Claude login is already in progress.";
    case "invalid_code":
    case "invalid_login_code": return "Invalid Claude login code.";
    default: return "Claude account request was rejected.";
  }
}

function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value)
    ? value
    : "node_command_rejected";
}

function accountIdOrError(reply: FastifyReply, value: string): string | undefined {
  if (isAccountId(value)) return value;
  sendPoolError(reply, 400, "invalid_request", "Invalid Claude account id.");
  return undefined;
}

function parseAccountPatch(value: unknown): { enabled?: boolean; priority?: number | null } | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== "enabled" && key !== "priority")) return null;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return null;
  if (value.priority !== undefined && value.priority !== null && (
    typeof value.priority !== "number" || !Number.isFinite(value.priority)
  )) return null;
  return {
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    ...(value.priority === undefined ? {} : { priority: value.priority }),
  };
}

function parseLoginStartBody(value: unknown): string | null | undefined {
  const body = value === undefined ? {} : value;
  if (!isRecord(body)) return undefined;
  if (Object.keys(body).some((key) => key !== "account_id")) return undefined;
  if (body.account_id === undefined) return null;
  return isAccountId(body.account_id) ? body.account_id : undefined;
}

function parseLoginCode(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "code")) return null;
  const code = value.code;
  return typeof code === "string" && code.length > 0 && !/[\r\n]/.test(code) ? code : null;
}

function accountListFromSummary(
  summary: Awaited<ReturnType<UsageSummaryService["refreshNode"]>>,
  nodeId: string,
): {
  readonly mode: "legacy" | "pool";
  readonly accounts: readonly unknown[];
  readonly pool: unknown;
  readonly fable_pool: unknown;
} | null {
  const provider = summary.nodes.find((node) => node.nodeId === nodeId)?.providers.claude;
  if (
    provider?.mode !== "pool"
    || provider.accounts === undefined
    || provider.pool === undefined
    || provider.fable_pool === undefined
  ) return null;
  return {
    mode: provider.mode,
    accounts: provider.accounts,
    pool: provider.pool,
    fable_pool: provider.fable_pool,
  };
}

function mergeDeleteResult(
  value: unknown,
  list: NonNullable<ReturnType<typeof accountListFromSummary>>,
): unknown {
  if (!isRecord(value)) return value;
  return { ...value, accounts: list.accounts, pool: list.pool };
}

function loginFlowIsDone(value: unknown): boolean {
  return isRecord(value) && value.state === "done";
}

function isAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
