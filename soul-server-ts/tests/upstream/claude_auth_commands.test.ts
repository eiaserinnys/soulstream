import { describe, expect, it, vi } from "vitest";

import type { AgentRegistry } from "../../src/agent_registry.js";
import type {
  ClaudeAuthCommandHandler,
  ClaudeAuthSetTokenCmd,
} from "../../src/auth/claude_auth.js";
import {
  ClaudeAuthCommandError,
  ClaudeAuthCommands,
  type ClaudeAuthCommand,
} from "../../src/upstream/claude_auth_commands.js";

function createAgentRegistry(backends: string[]): Pick<AgentRegistry, "supportedBackends"> {
  return {
    supportedBackends: vi.fn(() => backends),
  };
}

function createClaudeAuth(
  overrides: Partial<ClaudeAuthCommandHandler> = {},
): ClaudeAuthCommandHandler {
  return {
    status: vi.fn((requestId, responseType) => ({
      type: responseType,
      requestId,
      has_token: true,
    })),
    setToken: vi.fn((_cmd: ClaudeAuthSetTokenCmd, requestId, responseType) => ({
      response: {
        type: responseType,
        requestId,
        success: true,
      },
    })),
    deleteToken: vi.fn((requestId, responseType) => ({
      type: responseType,
      requestId,
      success: true,
    })),
    fetchUsage: vi.fn(async (requestId, responseType) => ({
      type: responseType,
      requestId,
      success: true,
      data: { five_hour: null },
    })),
    fetchProfile: vi.fn(async (requestId, responseType) => ({
      type: responseType,
      requestId,
      success: true,
      data: { account: { email: "agent@example.com" } },
    })),
    ...overrides,
  };
}

describe("claude auth command boundary", () => {
  const unsupportedAccountCommands: ClaudeAuthCommand[] = [
    { type: "claude_auth_accounts_list" },
    { type: "claude_auth_account_update", account_id: "account-1" },
    { type: "claude_auth_account_delete", account_id: "account-1" },
    { type: "claude_auth_login_start" },
    { type: "claude_auth_login_status", login_id: "login-1" },
    { type: "claude_auth_login_submit_code", login_id: "login-1", code: "code" },
    { type: "claude_auth_login_cancel", login_id: "login-1" },
  ];

  it.each(unsupportedAccountCommands)(
    "returns the existing not-implemented error for $type",
    async (command) => {
      const commands = new ClaudeAuthCommands({
        agentRegistry: createAgentRegistry([]),
        claudeAuth: undefined,
      });

      await expect(
        commands.handle({ ...command, requestId: "pool-unsupported" }),
      ).rejects.toEqual(
        new ClaudeAuthCommandError(
          `Not implemented in soul-server-ts: ${command.type}`,
        ),
      );
    },
  );

  it("validates Claude backend support and normalizes requestId before status routing", async () => {
    const auth = createClaudeAuth();
    const commands = new ClaudeAuthCommands({
      agentRegistry: createAgentRegistry(["codex", "claude"]),
      claudeAuth: auth,
    });

    const ack = await commands.handle({
      type: "claude_auth_status",
      request_id: "auth-snake",
    });

    expect(auth.status).toHaveBeenCalledWith("auth-snake", "claude_auth_status");
    expect(ack).toEqual({
      type: "claude_auth_status",
      requestId: "auth-snake",
      has_token: true,
    });
  });

  it("routes set_token errors through a command error without leaking a success response", async () => {
    const auth = createClaudeAuth({
      setToken: vi.fn(() => ({ error: "invalid token format" })),
    });
    const commands = new ClaudeAuthCommands({
      agentRegistry: createAgentRegistry(["claude"]),
      claudeAuth: auth,
    });

    await expect(
      commands.handle({
        type: "claude_auth_set_token",
        requestId: "auth-bad",
        token: "bad-token",
      }),
    ).rejects.toEqual(new ClaudeAuthCommandError("invalid token format"));
  });

  it("maps delete, usage, and profile commands to matching response types", async () => {
    const auth = createClaudeAuth();
    const commands = new ClaudeAuthCommands({
      agentRegistry: createAgentRegistry(["claude"]),
      claudeAuth: auth,
    });

    await expect(
      commands.handle({ type: "claude_auth_delete_token", requestId: "auth-del" }),
    ).resolves.toMatchObject({
      type: "claude_auth_delete_token",
      requestId: "auth-del",
      success: true,
    });
    await expect(
      commands.handle({ type: "claude_auth_get_usage", requestId: "auth-usage" }),
    ).resolves.toMatchObject({
      type: "claude_auth_get_usage",
      requestId: "auth-usage",
      success: true,
    });
    await expect(
      commands.handle({ type: "claude_auth_get_profile", requestId: "auth-profile" }),
    ).resolves.toMatchObject({
      type: "claude_auth_get_profile",
      requestId: "auth-profile",
      success: true,
    });

    expect(auth.deleteToken).toHaveBeenCalledWith("auth-del", "claude_auth_delete_token");
    expect(auth.fetchUsage).toHaveBeenCalledWith("auth-usage", "claude_auth_get_usage");
    expect(auth.fetchProfile).toHaveBeenCalledWith(
      "auth-profile",
      "claude_auth_get_profile",
    );
  });

  it("fails explicitly before touching the auth service on non-Claude nodes", async () => {
    const auth = createClaudeAuth();
    const commands = new ClaudeAuthCommands({
      agentRegistry: createAgentRegistry(["codex"]),
      claudeAuth: auth,
    });

    await expect(
      commands.handle({ type: "claude_auth_status", requestId: "auth-codex" }),
    ).rejects.toEqual(
      new ClaudeAuthCommandError(
        "Claude backend is not registered on this node; Claude auth commands are unsupported",
      ),
    );
    expect(auth.status).not.toHaveBeenCalled();
  });

  it("fails explicitly when the Claude auth service is not configured", async () => {
    const commands = new ClaudeAuthCommands({
      agentRegistry: createAgentRegistry(["claude"]),
      claudeAuth: undefined,
    });

    await expect(
      commands.handle({ type: "claude_auth_status", requestId: "auth-missing" }),
    ).rejects.toEqual(
      new ClaudeAuthCommandError("Claude auth service is not configured in soul-server-ts"),
    );
  });

  it("routes claude_auth_accounts_list, claude_auth_account_update, and claude_auth_account_delete to claudeAccounts when wired", async () => {
    const sampleAccount = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "alpha@example.com",
      plan: "max",
      enabled: true,
      priority: 1,
      auth_state: "ok" as const,
      active_sessions: 0,
      blocked: { resets_at: null, observed_at: null },
      stale: false,
      observed_at: "2026-10-28T01:00:00.000Z",
      usage: {
        five_hour: { used_percent: 10, resets_at: "2026-10-28T05:00:00.000Z" },
        seven_day: { used_percent: 20, resets_at: "2026-11-03T00:00:00.000Z" },
        fable_weekly: null,
      },
    };
    const samplePool = {
      total_count: 1,
      available_count: 1,
      best_weekly_remaining_percent: 80,
      best_weekly_resets_at: "2026-11-03T00:00:00.000Z",
      earliest_available_at: null,
    };

    const claudeAccounts = {
      getAccountList: vi.fn(async () => ({
        mode: "pool" as const,
        accounts: [sampleAccount],
        pool: samplePool,
        fable_pool: samplePool,
      })),
      updateAccount: vi.fn(async () => ({
        ...sampleAccount,
        enabled: false,
        priority: 3,
      })),
      deleteAccount: vi.fn(async () => ({
        id: sampleAccount.id,
        deleted: true as const,
        deferred: false,
        accounts: [],
        pool: {
          total_count: 0,
          available_count: 0,
          best_weekly_remaining_percent: null,
          best_weekly_resets_at: null,
          earliest_available_at: null,
        },
        fable_pool: {
          total_count: 0,
          available_count: 0,
          best_weekly_remaining_percent: null,
          best_weekly_resets_at: null,
          earliest_available_at: null,
        },
      })),
    };

    const commands = new ClaudeAuthCommands({
      agentRegistry: createAgentRegistry(["claude"]),
      claudeAuth: createClaudeAuth(),
      claudeAccounts,
    });

    const listRes = await commands.handle({
      type: "claude_auth_accounts_list",
      requestId: "req-list",
    });
    expect(listRes).toEqual({
      type: "claude_auth_accounts_list",
      requestId: "req-list",
      success: true,
      data: {
        mode: "pool",
        accounts: [
          {
            id: sampleAccount.id,
            email: sampleAccount.email,
            plan: sampleAccount.plan,
            enabled: true,
            priority: 1,
            auth_state: "ok",
            usage: sampleAccount.usage,
            observed_at: sampleAccount.observed_at,
            blocked: sampleAccount.blocked,
            active_sessions: 0,
          },
        ],
        pool: samplePool,
        fable_pool: samplePool,
      },
    });

    const updateRes = await commands.handle({
      type: "claude_auth_account_update",
      requestId: "req-update",
      account_id: sampleAccount.id,
      enabled: false,
      priority: 3,
    });
    expect(claudeAccounts.updateAccount).toHaveBeenCalledWith(sampleAccount.id, {
      enabled: false,
      priority: 3,
    });
    expect(updateRes).toMatchObject({
      type: "claude_auth_account_update",
      requestId: "req-update",
      success: true,
      data: {
        mode: "pool",
      },
    });

    const deleteRes = await commands.handle({
      type: "claude_auth_account_delete",
      requestId: "req-delete",
      account_id: sampleAccount.id,
    });
    expect(claudeAccounts.deleteAccount).toHaveBeenCalledWith(sampleAccount.id);
    expect(deleteRes).toMatchObject({
      type: "claude_auth_account_delete",
      requestId: "req-delete",
      success: true,
      data: {
        deferred: false,
        accounts: [],
        pool: { total_count: 0, available_count: 0 },
      },
    });

    await expect(
      commands.handle({
        type: "claude_auth_login_start",
        requestId: "req-login-p3",
      }),
    ).rejects.toEqual(
      new ClaudeAuthCommandError(
        "Not implemented in soul-server-ts: claude_auth_login_start",
      ),
    );
  });
});
