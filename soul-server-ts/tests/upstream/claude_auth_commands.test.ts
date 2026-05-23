import { describe, expect, it, vi } from "vitest";

import type { AgentRegistry } from "../../src/agent_registry.js";
import type {
  ClaudeAuthCommandHandler,
  ClaudeAuthSetTokenCmd,
} from "../../src/auth/claude_auth.js";
import {
  ClaudeAuthCommandError,
  ClaudeAuthCommands,
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
});
