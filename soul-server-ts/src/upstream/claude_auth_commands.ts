import type { AgentRegistry } from "../agent_registry.js";
import type {
  ClaudeAccount,
  ClaudeAccountList as WireClaudeAccountList,
  ClaudeAuthAccountDelete,
  ClaudeAuthAccountsList,
  ClaudeAuthAccountUpdate,
  ClaudeAuthLoginCancel,
  ClaudeAuthLoginFlow,
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
import {
  ClaudeAccountNotFoundError,
  type ClaudeAccountService,
  type ClaudeAccountView,
} from "../claude_accounts/index.js";
import {
  ClaudeLoginError,
  type ClaudeLoginService,
} from "../claude_accounts/login_service.js";

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
  | ClaudeAuthApiResponse
  | ClaudeAuthAccountsList
  | ClaudeAuthAccountUpdate
  | ClaudeAuthAccountDelete
  | ClaudeAuthLoginStart
  | ClaudeAuthLoginStatus
  | ClaudeAuthLoginSubmitCode
  | ClaudeAuthLoginCancel;

export class ClaudeAuthCommandError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ClaudeAuthCommandError";
    this.code = code;
  }
}

export type ClaudeAccountsCommandHandler = Pick<
  ClaudeAccountService,
  "getAccountList" | "updateAccount" | "deleteAccount"
>;

export type ClaudeLoginCommandHandler = Pick<
  ClaudeLoginService,
  "start" | "status" | "submit_code" | "cancel"
>;

function toWireClaudeAccount(account: ClaudeAccountView): ClaudeAccount {
  return {
    id: account.id,
    email: account.email,
    plan: account.plan,
    enabled: account.enabled,
    priority: account.priority,
    auth_state: account.auth_state,
    usage: account.usage,
    observed_at: account.observed_at,
    blocked: account.blocked,
    active_sessions: account.active_sessions,
  };
}

function toWireClaudeAccountList(
  list: Awaited<ReturnType<ClaudeAccountsCommandHandler["getAccountList"]>>,
): WireClaudeAccountList {
  return {
    mode: list.mode,
    accounts: list.accounts.map(toWireClaudeAccount),
    pool: list.pool,
    fable_pool: list.fable_pool,
  };
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
      claudeAccounts?: ClaudeAccountsCommandHandler;
      claudeLoginService?: ClaudeLoginCommandHandler;
      claudeAccountPoolEnabled?: boolean;
    },
  ) {}

  async handle(cmd: ClaudeAuthCommand): Promise<ClaudeAuthCommandResponse | null> {
    const requestId = commandRequestId(cmd);
    if (isClaudeAuthLoginCommand(cmd)) {
      if (!this.deps.claudeAccountPoolEnabled) {
        throw new ClaudeAuthCommandError(`Not implemented in soul-server-ts: ${cmd.type}`);
      }
      if (!this.deps.claudeLoginService) {
        throw new ClaudeAuthCommandError("Claude login service is not configured in soul-server-ts");
      }
      return this.handleLoginCommand(cmd, requestId);
    }
    if (
      this.deps.claudeAccountPoolEnabled &&
      (cmd.type === "claude_auth_set_token" || cmd.type === "claude_auth_delete_token")
    ) {
      throw new ClaudeAuthCommandError(
        "Use the Claude account login flow",
        "login_flow_required",
      );
    }
    if (isClaudeAuthAccountPoolCommand(cmd)) {
      return this.handleAccountPoolCommand(cmd, requestId);
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

  private async handleLoginCommand(
    cmd:
      | ClaudeAuthLoginStartCmd
      | ClaudeAuthLoginStatusCmd
      | ClaudeAuthLoginSubmitCodeCmd
      | ClaudeAuthLoginCancelCmd,
    requestId: string,
  ): Promise<ClaudeAuthCommandResponse> {
    if (!this.deps.agentRegistry.supportedBackends().includes("claude")) {
      throw new ClaudeAuthCommandError(
        "Claude backend is not registered on this node; Claude auth commands are unsupported",
      );
    }
    const loginService = this.deps.claudeLoginService!;
    let data: ClaudeAuthLoginFlow;
    try {
      switch (cmd.type) {
        case "claude_auth_login_start":
          data = await loginService.start({ account_id: cmd.account_id });
          break;
        case "claude_auth_login_status":
          data = await loginService.status({ login_id: cmd.login_id });
          break;
        case "claude_auth_login_submit_code":
          data = await loginService.submit_code({ login_id: cmd.login_id, code: cmd.code });
          break;
        case "claude_auth_login_cancel":
          data = await loginService.cancel({ login_id: cmd.login_id });
          break;
      }
      return { type: cmd.type, requestId, success: true, data };
    } catch (error) {
      return {
        type: cmd.type,
        requestId,
        success: false,
        error: error instanceof ClaudeLoginError
          ? error.toAuthError()
          : { code: "login_flow_failed", message: "Claude CLI login failed" },
      };
    }
  }

  private async handleAccountPoolCommand(
    cmd:
      | ClaudeAuthAccountsListCmd
      | ClaudeAuthAccountUpdateCmd
      | ClaudeAuthAccountDeleteCmd,
    requestId: string,
  ): Promise<ClaudeAuthCommandResponse> {
    if (!this.deps.claudeAccounts) {
      throw new ClaudeAuthCommandError(`Not implemented in soul-server-ts: ${cmd.type}`);
    }
    if (!this.deps.agentRegistry.supportedBackends().includes("claude")) {
      throw new ClaudeAuthCommandError(
        "Claude backend is not registered on this node; Claude auth commands are unsupported",
      );
    }

    const accountsService = this.deps.claudeAccounts;

    switch (cmd.type) {
      case "claude_auth_accounts_list": {
        const list = await accountsService.getAccountList();
        return {
          type: "claude_auth_accounts_list",
          requestId,
          success: true,
          data: toWireClaudeAccountList(list),
        };
      }
      case "claude_auth_account_update": {
        try {
          await accountsService.updateAccount(cmd.account_id, {
            enabled: cmd.enabled,
            priority: cmd.priority,
          });
          const list = await accountsService.getAccountList();
          return {
            type: "claude_auth_account_update",
            requestId,
            success: true,
            data: toWireClaudeAccountList(list),
          };
        } catch (err) {
          const code =
            err instanceof ClaudeAccountNotFoundError
              ? err.code
              : "ACCOUNT_UPDATE_FAILED";
          const message = err instanceof Error ? err.message : String(err);
          return {
            type: "claude_auth_account_update",
            requestId,
            success: false,
            error: { code, message },
          };
        }
      }
      case "claude_auth_account_delete": {
        try {
          const deleted = await accountsService.deleteAccount(cmd.account_id);
          return {
            type: "claude_auth_account_delete",
            requestId,
            success: true,
            data: {
              deferred: deleted.deferred,
              accounts: deleted.accounts.map(toWireClaudeAccount),
              pool: deleted.pool,
            },
          };
        } catch (err) {
          const code =
            err instanceof ClaudeAccountNotFoundError
              ? err.code
              : "ACCOUNT_DELETE_FAILED";
          const message = err instanceof Error ? err.message : String(err);
          return {
            type: "claude_auth_account_delete",
            requestId,
            success: false,
            error: { code, message },
          };
        }
      }
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

function isClaudeAuthAccountPoolCommand(
  cmd: ClaudeAuthCommand,
): cmd is
  | ClaudeAuthAccountsListCmd
  | ClaudeAuthAccountUpdateCmd
  | ClaudeAuthAccountDeleteCmd {
  return (
    cmd.type === "claude_auth_accounts_list" ||
    cmd.type === "claude_auth_account_update" ||
    cmd.type === "claude_auth_account_delete"
  );
}

function isClaudeAuthLoginCommand(
  cmd: ClaudeAuthCommand,
): cmd is
  | ClaudeAuthLoginStartCmd
  | ClaudeAuthLoginStatusCmd
  | ClaudeAuthLoginSubmitCodeCmd
  | ClaudeAuthLoginCancelCmd {
  return (
    cmd.type === "claude_auth_login_start" ||
    cmd.type === "claude_auth_login_status" ||
    cmd.type === "claude_auth_login_submit_code" ||
    cmd.type === "claude_auth_login_cancel"
  );
}
