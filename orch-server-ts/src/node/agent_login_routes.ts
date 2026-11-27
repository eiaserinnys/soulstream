import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { isRecord } from "@soulstream/wire-schema/json-record";
import { requireAdmin, type AdminAccessProvider } from "../admin/admin_access.js";
import type { NodeCommandResponse, RequestResponseNodeCommandPayload } from "./pending_commands.js";
import type { InMemoryNodeRegistry } from "./registry.js";
import { supportsAgentLogin } from "./registry_helpers.js";
import type { SessionCommandTransportBridge } from "../session/session_command_transport.js";
import type { UsageSummaryService } from "../usage/usage_summary_service.js";

export type AgentLoginRouteOptions = {
  readonly registry: InMemoryNodeRegistry;
  readonly bridge: SessionCommandTransportBridge;
  readonly usageSummary: Pick<UsageSummaryService, "refreshNode">;
  readonly timeoutMs?: number;
  /** 주어지면 관리자만 부를 수 있다. 관리자 전용 설정 경로가 쓰는 판정(requireAdmin)과 같다. */
  readonly adminAccess?: AdminAccessProvider;
};

export const agentLoginRouteAuthRequirements = {
  "POST /api/nodes/:node_id/agent-logins/:provider": true,
  "GET /api/nodes/:node_id/agent-logins/:login_id": true,
  "POST /api/nodes/:node_id/agent-logins/:login_id/code": true,
  "DELETE /api/nodes/:node_id/agent-logins/:login_id": true,
} as const;

type NodeParams = { node_id: string };
type ProviderParams = NodeParams & { provider: string };
type LoginParams = NodeParams & { login_id: string };
type LoginCommandResult = NodeCommandResponse & { success?: unknown; data?: unknown; error?: unknown };

const PROVIDER_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_CODE_BODY_LENGTH = 4_096;
const WORKER_REJECTION_STATUS: Readonly<Record<string, 404 | 409 | 422>> = {
  login_not_found: 404,
  agent_login_unsupported: 409,
  cli_not_installed: 409,
  login_not_ready: 409,
  code_not_expected: 409,
  invalid_request: 422,
};

export function registerAgentLoginRoutes(app: FastifyInstance, options: AgentLoginRouteOptions): void {
  app.post<{ Params: ProviderParams }>(
    "/api/nodes/:node_id/agent-logins/:provider",
    async (request, reply) => {
      if (!PROVIDER_NAME.test(request.params.provider)) {
        return sendLoginError(reply, 422, "invalid_request", "올바르지 않은 로그인 공급자입니다.");
      }
      if (request.params.provider === "antigravity" && options.registry.isAntigravityEnabled?.() === false) {
        return sendLoginError(reply, 409, "ANTIGRAVITY_DISABLED", "Antigravity가 설정에서 꺼져 있습니다.");
      }
      return sendLoginCommand(request, reply, options, request.params.node_id,
        { type: "agent_login_start", provider: request.params.provider }, 202);
    },
  );

  app.get<{ Params: LoginParams }>(
    "/api/nodes/:node_id/agent-logins/:login_id",
    async (request, reply) => sendLoginCommand(request, reply, options, request.params.node_id,
      { type: "agent_login_status", login_id: request.params.login_id }, 200),
  );

  app.post<{ Params: LoginParams; Body: unknown }>(
    "/api/nodes/:node_id/agent-logins/:login_id/code",
    async (request, reply) => {
      // 본문은 이 경로의 처리기 밖으로 나가지 않는다. 요청 로그에도 본문은 실리지 않는다.
      const code = parseCodeBody(request.body);
      if (code === null) return sendLoginError(reply, 422, "invalid_request", "올바르지 않은 인증 코드입니다.");
      return sendLoginCommand(request, reply, options, request.params.node_id,
        { type: "agent_login_submit_code", login_id: request.params.login_id, code }, 200);
    },
  );

  app.delete<{ Params: LoginParams }>(
    "/api/nodes/:node_id/agent-logins/:login_id",
    async (request, reply) => sendLoginCommand(request, reply, options, request.params.node_id,
      { type: "agent_login_cancel", login_id: request.params.login_id }, 200),
  );
}

async function sendLoginCommand(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AgentLoginRouteOptions,
  nodeId: string,
  payload: RequestResponseNodeCommandPayload,
  successStatus: number,
): Promise<FastifyReply> {
  if (options.adminAccess !== undefined && await requireAdmin(request, reply, options.adminAccess) === undefined) {
    return reply;
  }
  const node = options.registry.getConnectedNode(nodeId);
  if (node === undefined) return sendLoginError(reply, 404, "node_not_connected", "노드가 연결되어 있지 않습니다.");
  if (!supportsAgentLogin(node.capabilities)) {
    return sendLoginError(reply, 409, "agent_login_unsupported", "이 노드는 Codex와 Antigravity 로그인을 지원하지 않습니다.");
  }

  let response: LoginCommandResult;
  try {
    const command = options.registry.createCommand(nodeId, payload, { timeoutMs: options.timeoutMs });
    response = await options.bridge.sendPendingCommand({ node, command }) as LoginCommandResult;
  } catch (error) {
    const code = error instanceof Error && error.name === "PendingNodeCommandTimeoutError"
      ? "node_command_timeout"
      : "node_command_failed";
    return sendLoginError(reply, 502, code, "로그인 노드 요청을 처리하지 못했습니다.");
  }
  if (response.success !== true) return sendNodeRejection(reply, response);

  if (isRecord(response.data) && response.data.state === "done") {
    // 로그인이 끝났으니 그 노드의 사용량을 곧바로 다시 읽는다. 실패해도 로그인 결과는 그대로 돌려준다.
    try {
      await options.usageSummary.refreshNode(nodeId);
    } catch {
      request.log.warn({ nodeId }, "Usage refresh after agent login failed");
    }
  }
  return reply.code(successStatus).send(response.data);
}

function sendNodeRejection(reply: FastifyReply, response: LoginCommandResult): FastifyReply {
  const workerError = isRecord(response.error) ? response.error : null;
  const code = safeErrorCode(workerError?.code);
  return sendLoginError(reply, WORKER_REJECTION_STATUS[code] ?? 502, code, errorMessage(code));
}

function sendLoginError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ code, message });
}

function errorMessage(code: string): string {
  switch (code) {
    case "login_not_found": return "로그인 세션을 찾을 수 없습니다.";
    case "agent_login_unsupported": return "지원하지 않는 로그인입니다.";
    case "cli_not_installed": return "이 노드에 해당 CLI가 설치되어 있지 않습니다.";
    case "login_not_ready": return "아직 인증 코드를 입력할 수 있는 상태가 아닙니다.";
    case "code_not_expected": return "이 로그인은 인증 코드를 입력하지 않습니다.";
    case "invalid_request": return "올바르지 않은 로그인 요청입니다.";
    default: return "로그인 요청이 거절되었습니다.";
  }
}

function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value)
    ? value.toLowerCase()
    : "node_command_rejected";
}

function parseCodeBody(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "code")) return null;
  const code = value.code;
  return typeof code === "string" && code.trim().length > 0 && code.length <= MAX_CODE_BODY_LENGTH ? code : null;
}
