import { describe, expect, it, vi } from "vitest";
import {
  accountPath,
  cancelClaudeAccountLogin,
  CENTRAL_CLAUDE_TARGET,
  claudeAccountsPath,
  claudeCentralSettingsPath,
  claudeLoginsPath,
  getClaudeCentralSettings,
  loginPath,
  nodeClaudeTarget,
  putClaudeCentralReceive,
} from "./claude-auth-api";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("claude-auth-api targets", () => {
  it("builds the node and central account paths from one target type", () => {
    const node = nodeClaudeTarget("node/a");
    expect(claudeAccountsPath(node)).toBe("/api/nodes/node%2Fa/claude-auth/accounts");
    expect(accountPath(node, "account/1")).toBe("/api/nodes/node%2Fa/claude-auth/accounts/account%2F1");
    expect(claudeAccountsPath(CENTRAL_CLAUDE_TARGET)).toBe("/api/claude-auth/central/accounts");
    expect(accountPath(CENTRAL_CLAUDE_TARGET, "account/1")).toBe("/api/claude-auth/central/accounts/account%2F1");
  });

  it("builds login paths for both targets", () => {
    expect(claudeLoginsPath(nodeClaudeTarget("node-a"))).toBe("/api/nodes/node-a/claude-auth/logins");
    expect(loginPath(nodeClaudeTarget("node-a"), "login/1")).toBe("/api/nodes/node-a/claude-auth/logins/login%2F1");
    expect(claudeLoginsPath(CENTRAL_CLAUDE_TARGET)).toBe("/api/claude-auth/central/logins");
    expect(loginPath(CENTRAL_CLAUDE_TARGET, "login/1")).toBe("/api/claude-auth/central/logins/login%2F1");
    expect(claudeCentralSettingsPath()).toBe("/api/claude-auth/central/settings");
  });

  it("reads central settings and writes only the changed node's receive value", async () => {
    const settings = {
      default_receive: true,
      nodes: { "node-a": false },
      effective: [{ node_id: "node-a", receive: false, connected: true }],
    };
    const request = vi.fn(async () => json(settings)) as unknown as typeof fetch;

    await expect(getClaudeCentralSettings(request)).resolves.toEqual(settings);
    await putClaudeCentralReceive(request, "node/a", true);

    expect(request).toHaveBeenNthCalledWith(1, "/api/claude-auth/central/settings", expect.objectContaining({ method: "GET" }));
    expect(request).toHaveBeenNthCalledWith(2, "/api/claude-auth/central/settings", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ nodes: { "node/a": true } }),
    }));
  });

  it("cancels a central login through the central login path", async () => {
    const flow = {
      login_id: "login-a",
      account_id: null,
      state: "cancelled",
      auth_url: null,
      expires_at: "2030-01-01T00:00:00.000Z",
      error: null,
    };
    const request = vi.fn(async () => json(flow)) as unknown as typeof fetch;

    await expect(cancelClaudeAccountLogin(request, CENTRAL_CLAUDE_TARGET, "login-a")).resolves.toEqual(flow);
    expect(request).toHaveBeenCalledWith("/api/claude-auth/central/logins/login-a", expect.objectContaining({ method: "DELETE" }));
  });
});
