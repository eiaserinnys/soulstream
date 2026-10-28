import type { AgentRegistry } from "../agent_registry.js";
import type {
  ClaudeAuthAccountDelete,
  ClaudeAuthAccountsList,
  ClaudeAuthAccountUpdate,
  ClaudeAuthLoginCancel,
  ClaudeAuthLoginStart,
  ClaudeAuthLoginStatus,
  ClaudeAuthLoginSubmitCode,
} from "@soulstream/wire-schema";
import type {
  ClaudeAuthApiResponse,
  ClaudeAuthCommandHandler,
  ClaudeAuthDeleteTokenResponse,
  ClaudeAuthSetTokenCmd,
  ClaudeAuthSetTokenResponse,
  ClaudeAuthStatusResponse,
} from "../auth/claude_auth.js";

interface CommandLike {
  type?: string;
  requestId?: string;
  request_id?: string;
}

type ClaudeAuthStatusCmd = CommandLike & { type: "claude_auth_status" };
type ClaudeAuthDeleteCmd = CommandLike & { type: "claude_auth_delete_token" };
type ClaudeAuthUsageCmd = CommandLike & { type: "claude_auth_get_usage" };
type ClaudeAuthProfileCmd = CommandLike & { type: "claude_auth_get_profile" };
type ClaudeAuthAccountsListCmd = CommandLike &
  Pick<ClaudeAuthAccountsList, "type" | "requestId">;
type ClaudeAuthAccountUpdateCmd = CommandLike &
  Pick<ClaudeAuthAccountUpdate, "type" | "requestId" | "account_id" | "enabled" | "priority">;
type ClaudeAuthAccountDeleteCmd = CommandLike &
  Pick<ClaudeAuthAccountDelete, "type" | "requestId" | "account_id">;
type ClaudeAuthLoginStartCmd = CommandLike &
  Pick<ClaudeAuthLoginStart, "type" | "requestId" | "account_id">;
type ClaudeAuthLoginStatusCmd = CommandLike &
  Pick<ClaudeAuthLoginStatus, "type" | "requestId" | "login_id">;
type ClaudeAuthLoginSubmitCodeCmd = CommandLike &
  Pick<ClaudeAuthLoginSubmitCode, "type" | "requestId" | "login_id" | "code">;
type ClaudeAuthLoginCancelCmd = CommandLike &
  Pick<ClaudeAuthLoginCancel, "type" | "requestId" | "login_id">;

type ClaudeAuthAccountCommand =
  | ClaudeAuthAccountsListCmd
  | ClaudeAuthAccountUpdateCmd
  | ClaudeAuthAccountDeleteCmd
  | ClaudeAuthLoginStartCmd
  | ClaudeAuthLoginStatusCmd
  | ClaudeAuthLoginSubmitCodeCmd
  | ClaudeAuthLoginCancelCmd;

export type ClaudeAuthCommand =
  | ClaudeAuthStatusCmd
  | (CommandLike & ClaudeAuthSetTokenCmd)
  | ClaudeAuthDeleteCmd
  | ClaudeAuthUsageCmd
  | ClaudeAuthProfileCmd
  | ClaudeAuthAccountCommand;

export type ClaudeAuthCommandResponse =
  | ClaudeAuthStatusResponse
  | ClaudeAuthSetTokenResponse
  | ClaudeAuthDeleteTokenResponse
  | ClaudeAuthApiResponse;

export class ClaudeAuthCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeAuthCommandError";
  }
}

/**
 * Owns upstream Claude auth command semantics.
 *
 * ClaudeAuthService owns token storage and Anthropic OAuth calls. This boundary
 * owns the upstream command layer around it: Claude backend support validation,
 * required service validation, requestId normalization, command type routing,
 * and set_token error normalization. Dispatcher still owns raw command routing
 * and the generic sendError envelope.
 */
export class ClaudeAuthCommands {
  constructor(
    private readonly deps: {
      agentRegistry: Pick<AgentRegistry, "supportedBackends">;
      claudeAuth?: ClaudeAuthCommandHandler;
    },
  ) {}

  async handle(cmd: ClaudeAuthCommand): Promise<ClaudeAuthCommandResponse | null> {
    const requestId = commandRequestId(cmd);
    if (isClaudeAuthAccountCommand(cmd)) {
      throw new ClaudeAuthCommandError(`Not implemented in soul-server-ts: ${cmd.type}`);
    }
    const auth = this.requireAuth();

    switch (cmd.type) {
      case "claude_auth_status":
        return auth.status(requestId, cmd.type);
      case "claude_auth_set_token": {
        const result = auth.setToken(cmd, requestId, cmd.type);
        if (result.error) {
          throw new ClaudeAuthCommandError(result.error);
        }
        return result.response ?? null;
      }
      case "claude_auth_delete_token":
        return auth.deleteToken(requestId, cmd.type);
      case "claude_auth_get_usage":
        return auth.fetchUsage(requestId, cmd.type);
      case "claude_auth_get_profile":
        return auth.fetchProfile(requestId, cmd.type);
    }
  }

  private requireAuth(): ClaudeAuthCommandHandler {
    if (!this.deps.agentRegistry.supportedBackends().includes("claude")) {
      throw new ClaudeAuthCommandError(
        "Claude backend is not registered on this node; Claude auth commands are unsupported",
      );
    }
    if (!this.deps.claudeAuth) {
      throw new ClaudeAuthCommandError(
        "Claude auth service is not configured in soul-server-ts",
      );
    }
    return this.deps.claudeAuth;
  }
}

function commandRequestId(cmd: CommandLike): string {
  return cmd.requestId ?? cmd.request_id ?? "";
}

function isClaudeAuthAccountCommand(
  cmd: ClaudeAuthCommand,
): cmd is ClaudeAuthAccountCommand {
  return cmd.type === "claude_auth_accounts_list"
    || cmd.type === "claude_auth_account_update"
    || cmd.type === "claude_auth_account_delete"
    || cmd.type === "claude_auth_login_start"
    || cmd.type === "claude_auth_login_status"
    || cmd.type === "claude_auth_login_submit_code"
    || cmd.type === "claude_auth_login_cancel";
}
