import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { ClaudeAccountService } from "../../src/claude_accounts/service.js";
import { ClaudeLoginService } from "../../src/claude_accounts/login_service.js";

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

type LoginCommandResponse = {
  success?: boolean;
  data?: {
    login_id: string;
    account_id: string | null;
    state: string;
    auth_url: string | null;
  };
  error?: { code: string; message: string };
};

async function waitForLoginResponse(
  read: () => Promise<LoginCommandResponse>,
  predicate: (response: LoginCommandResponse) => boolean,
): Promise<LoginCommandResponse> {
  const deadline = Date.now() + 3_000;
  let response = await read();
  while (!predicate(response)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Claude login flow");
    await new Promise((resolve) => setTimeout(resolve, 5));
    response = await read();
  }
  return response;
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

  it("runs the official CLI login through command handling and lists the registered account", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-auth-command-test-"));
    try {
      const cliPath = join(rootDir, "fake-claude-cli.mjs");
      const cliScript = [
        "#!/usr/bin/env node",
        "const [group, action] = process.argv.slice(2);",
        "if (group === 'auth' && action === 'login') {",
        "  process.stdout.write('Open: https://claude.ai/oauth/authorize?state=test-flow ');",
        "  process.stdin.resume();",
        "  process.stdin.once('end', () => process.exit(0));",
        "} else if (group === 'auth' && action === 'status') {",
        "  setTimeout(() => {",
        "    process.stdout.write(JSON.stringify({loggedIn:true,accountUuid:'11111111-1111-4111-8111-111111111111',email:'alpha@example.com',plan:'pro'}));",
        "    process.exit(0);",
        "  }, 100);",
        "} else {",
        "  process.exit(2);",
        "}",
      ].join("\n");
      await writeFile(cliPath, cliScript, { encoding: "utf8", mode: 0o755 });
      await chmod(cliPath, 0o755);

      const logEntries: unknown[][] = [];
      const logger = {
        info: (...args: unknown[]) => logEntries.push(args),
      } as unknown as import("pino").Logger;
      const accounts = new ClaudeAccountService({
        accountsDir: join(rootDir, "accounts"),
        homeDir: join(rootDir, "home"),
      });
      const login = new ClaudeLoginService({ port: accounts, logger, executablePath: cliPath });
      const commands = new ClaudeAuthCommands({
        agentRegistry: createAgentRegistry(["claude"]),
        claudeAuth: createClaudeAuth(),
        claudeAccounts: accounts,
        claudeLoginService: login,
        claudeAccountPoolEnabled: true,
      } as unknown as ConstructorParameters<typeof ClaudeAuthCommands>[0]);

      const started = await commands.handle({
        type: "claude_auth_login_start",
        requestId: "login-start",
      }) as LoginCommandResponse;
      expect(started).toMatchObject({
        type: "claude_auth_login_start",
        requestId: "login-start",
        success: true,
        data: { state: "requested", auth_url: null },
      });
      const loginId = started.data!.login_id;
      const readStatus = () => commands.handle({
        type: "claude_auth_login_status",
        requestId: "login-status",
        login_id: loginId,
      }) as Promise<LoginCommandResponse>;
      const urlReady = await waitForLoginResponse(
        readStatus,
        (response) => response.data?.state === "url_ready",
      );
      expect(urlReady.data?.auth_url).toBe("https://claude.ai/oauth/authorize?state=test-flow");

      const submitted = await commands.handle({
        type: "claude_auth_login_submit_code",
        requestId: "login-submit",
        login_id: loginId,
        code: "synthetic-login-code",
      }) as LoginCommandResponse;
      expect(submitted).toMatchObject({
        type: "claude_auth_login_submit_code",
        requestId: "login-submit",
        success: true,
        data: { state: "code_submitted" },
      });

      const observedStates = new Set<string>();
      const done = await waitForLoginResponse(
        async () => {
          const response = await readStatus();
          if (response.data?.state) observedStates.add(response.data.state);
          return response;
        },
        (response) => response.data?.state === "done",
      );
      expect(observedStates).toContain("verifying");
      expect(done.data?.account_id).toBe("11111111-1111-4111-8111-111111111111");

      const listed = await commands.handle({
        type: "claude_auth_accounts_list",
        requestId: "accounts-list",
      });
      expect(listed).toMatchObject({
        type: "claude_auth_accounts_list",
        requestId: "accounts-list",
        success: true,
        data: {
          accounts: [{
            id: "11111111-1111-4111-8111-111111111111",
            email: "alpha@example.com",
          }],
        },
      });
      const logs = JSON.stringify(logEntries);
      expect(logs).not.toContain("https://claude.ai/oauth/authorize");
      expect(logs).not.toContain("synthetic-login-code");
      expect(logs).not.toContain("loggedIn");

      const cancelStart = await commands.handle({
        type: "claude_auth_login_start",
        requestId: "cancel-start",
      }) as LoginCommandResponse;
      const cancelled = await commands.handle({
        type: "claude_auth_login_cancel",
        requestId: "cancel-flow",
        login_id: cancelStart.data!.login_id,
      }) as LoginCommandResponse;
      expect(cancelled).toMatchObject({
        type: "claude_auth_login_cancel",
        requestId: "cancel-flow",
        success: true,
        data: { state: "cancelled" },
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects legacy token mutation commands with login_flow_required in pool mode", async () => {
    const auth = createClaudeAuth();
    const commands = new ClaudeAuthCommands({
      agentRegistry: createAgentRegistry(["claude"]),
      claudeAuth: auth,
      claudeAccountPoolEnabled: true,
    } as unknown as ConstructorParameters<typeof ClaudeAuthCommands>[0]);

    await expect(commands.handle({
      type: "claude_auth_set_token",
      requestId: "legacy-set-token",
      token: "synthetic-token",
    })).rejects.toMatchObject({ code: "login_flow_required" });
    await expect(commands.handle({
      type: "claude_auth_delete_token",
      requestId: "legacy-delete-token",
    })).rejects.toMatchObject({ code: "login_flow_required" });
    expect(auth.setToken).not.toHaveBeenCalled();
    expect(auth.deleteToken).not.toHaveBeenCalled();
  });
});
