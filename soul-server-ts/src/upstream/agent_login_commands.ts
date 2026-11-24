import type {
  AgentLoginCancel,
  AgentLoginStart,
  AgentLoginStatus,
  AgentLoginSubmitCode,
} from "@soulstream/wire-schema";

import { AgentLoginServiceError } from "../agent_login/types.js";
import type { AgentLoginService } from "../agent_login/service.js";

interface CommandLike {
  type?: string;
  requestId?: string;
  request_id?: string;
}

type AgentLoginStartCmd = CommandLike & Pick<AgentLoginStart, "type" | "requestId" | "provider">;
type AgentLoginStatusCmd = CommandLike & Pick<AgentLoginStatus, "type" | "requestId" | "login_id">;
type AgentLoginSubmitCodeCmd = CommandLike &
  Pick<AgentLoginSubmitCode, "type" | "requestId" | "login_id" | "code">;
type AgentLoginCancelCmd = CommandLike & Pick<AgentLoginCancel, "type" | "requestId" | "login_id">;

export type AgentLoginCommand =
  | AgentLoginStartCmd
  | AgentLoginStatusCmd
  | AgentLoginSubmitCodeCmd
  | AgentLoginCancelCmd;

export type AgentLoginCommandResponse =
  | AgentLoginStart
  | AgentLoginStatus
  | AgentLoginSubmitCode
  | AgentLoginCancel;

export type AgentLoginCommandHandler = Pick<
  AgentLoginService,
  "start" | "status" | "submit_code" | "cancel"
>;

export class AgentLoginCommandError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "AgentLoginCommandError";
    this.code = code;
  }
}

/**
 * Codex와 Antigravity 로그인 명령. 흐름 안의 거절은 응답의 error(code, message)로 돌려주고,
 * 서비스가 없을 때만 디스패처 오류로 올린다. 응답과 거절 모양은 claude_auth_login_* 명령과 같다.
 */
export class AgentLoginCommands {
  constructor(private readonly deps: { agentLoginService?: AgentLoginCommandHandler }) {}

  async handle(cmd: AgentLoginCommand): Promise<AgentLoginCommandResponse> {
    const service = this.deps.agentLoginService;
    if (!service) {
      throw new AgentLoginCommandError("Agent login service is not configured in soul-server-ts");
    }
    const requestId = cmd.requestId ?? cmd.request_id ?? "";
    try {
      switch (cmd.type) {
        case "agent_login_start":
          return success(cmd.type, requestId, await service.start({ provider: requireString(cmd, "provider") }));
        case "agent_login_status":
          return success(cmd.type, requestId, await service.status({ login_id: requireString(cmd, "login_id") }));
        case "agent_login_submit_code":
          return success(cmd.type, requestId, await service.submit_code({
            login_id: requireString(cmd, "login_id"),
            code: requireString(cmd, "code"),
          }));
        case "agent_login_cancel":
          return success(cmd.type, requestId, await service.cancel({ login_id: requireString(cmd, "login_id") }));
      }
    } catch (error) {
      if (error instanceof AgentLoginCommandError) throw error;
      return {
        type: cmd.type,
        requestId,
        success: false,
        error: error instanceof AgentLoginServiceError
          ? error.toWire()
          : { code: "login_flow_failed", message: "Agent login failed" },
      } as AgentLoginCommandResponse;
    }
  }
}

function success<T extends AgentLoginCommandResponse["type"]>(
  type: T,
  requestId: string,
  data: NonNullable<AgentLoginCommandResponse["data"]>,
): AgentLoginCommandResponse {
  return { type, requestId, success: true, data } as AgentLoginCommandResponse;
}

/** 본문 값은 오케스트레이터가 이미 걸렀지만, 워커도 경계에서 한 번 확인한다. */
function requireString(cmd: object, key: "provider" | "login_id" | "code"): string {
  const value = (cmd as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentLoginServiceError("invalid_request", `${key} is required`);
  }
  return value;
}
