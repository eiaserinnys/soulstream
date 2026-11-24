import {
  CommandDispatchError,
  type CommandHandlerMap,
  type SendFn,
} from "./command_family.js";
import {
  AgentLoginCommandError,
  AgentLoginCommands,
  type AgentLoginCommand,
} from "./agent_login_commands.js";
import {
  ClaudeAuthCommandError,
  ClaudeAuthCommands,
  type ClaudeAuthCommand,
} from "./claude_auth_commands.js";
import {
  ProviderUsageCommandError,
  ProviderUsageCommands,
  type ProviderUsageCommand,
} from "./provider_usage_commands.js";

interface AuthCommandFamilyDeps {
  send: SendFn;
  claudeAuthCommands: ClaudeAuthCommands;
  agentLoginCommands: AgentLoginCommands;
  providerUsageCommands: ProviderUsageCommands;
}

export function createAuthCommandFamily(
  deps: AuthCommandFamilyDeps,
): CommandHandlerMap {
  return {
    claude_auth_status: (cmd) => handleClaudeAuth(deps, cmd as ClaudeAuthCommand),
    claude_auth_set_token: (cmd) => handleClaudeAuth(deps, cmd as ClaudeAuthCommand),
    claude_auth_delete_token: (cmd) =>
      handleClaudeAuth(deps, cmd as ClaudeAuthCommand),
    claude_auth_get_usage: (cmd) => handleClaudeAuth(deps, cmd as ClaudeAuthCommand),
    claude_auth_get_profile: (cmd) => handleClaudeAuth(deps, cmd as ClaudeAuthCommand),
    claude_auth_accounts_list: (cmd) => handleClaudeAuth(deps, cmd as ClaudeAuthCommand),
    claude_auth_account_update: (cmd) => handleClaudeAuth(deps, cmd as ClaudeAuthCommand),
    claude_auth_account_delete: (cmd) => handleClaudeAuth(deps, cmd as ClaudeAuthCommand),
    claude_auth_login_start: (cmd) => handleClaudeAuth(deps, cmd as ClaudeAuthCommand),
    claude_auth_login_status: (cmd) => handleClaudeAuth(deps, cmd as ClaudeAuthCommand),
    claude_auth_login_submit_code: (cmd) => handleClaudeAuth(deps, cmd as ClaudeAuthCommand),
    claude_auth_login_cancel: (cmd) => handleClaudeAuth(deps, cmd as ClaudeAuthCommand),
    agent_login_start: (cmd) => handleAgentLogin(deps, cmd as AgentLoginCommand),
    agent_login_status: (cmd) => handleAgentLogin(deps, cmd as AgentLoginCommand),
    agent_login_submit_code: (cmd) => handleAgentLogin(deps, cmd as AgentLoginCommand),
    agent_login_cancel: (cmd) => handleAgentLogin(deps, cmd as AgentLoginCommand),
    claude_central_pool_sync: (cmd) => handleClaudeAuth(deps, cmd as ClaudeAuthCommand),
    provider_usage_get: (cmd) =>
      handleProviderUsage(deps, cmd as ProviderUsageCommand),
  };
}

async function handleClaudeAuth(
  deps: AuthCommandFamilyDeps,
  cmd: ClaudeAuthCommand,
): Promise<void> {
  try {
    const response = await deps.claudeAuthCommands.handle(cmd);
    if (response) {
      await deps.send(response);
    }
  } catch (err) {
    if (err instanceof ClaudeAuthCommandError) {
      throw new CommandDispatchError(err.message, err.code);
    }
    throw err;
  }
}

async function handleAgentLogin(
  deps: AuthCommandFamilyDeps,
  cmd: AgentLoginCommand,
): Promise<void> {
  try {
    await deps.send(await deps.agentLoginCommands.handle(cmd));
  } catch (err) {
    if (err instanceof AgentLoginCommandError) {
      throw new CommandDispatchError(err.message, err.code);
    }
    throw err;
  }
}

async function handleProviderUsage(
  deps: AuthCommandFamilyDeps,
  cmd: ProviderUsageCommand,
): Promise<void> {
  try {
    await deps.send(await deps.providerUsageCommands.handle(cmd));
  } catch (err) {
    if (err instanceof ProviderUsageCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}
