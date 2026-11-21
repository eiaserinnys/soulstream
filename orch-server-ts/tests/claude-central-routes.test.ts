import { describe, expect, it, vi } from "vitest";

import { createApp, parseOrchServerConfig } from "../src/index.js";
import { ClaudeCentralLoginError } from "../src/claude_central/login_service.js";
import { ClaudeCentralNotFoundError } from "../src/claude_central/service.js";
import type { ClaudeCentralRouteService } from "../src/claude_central/routes.js";
import type { ClaudeCentralAccountList } from "../src/claude_central/types.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

function accountList(): ClaudeCentralAccountList {
  return {
    mode: "pool",
    accounts: [{
      id: ACCOUNT_ID,
      email: "central@example.com",
      plan: "max",
      enabled: true,
      priority: 0,
      auth_state: "ok",
      usage: { five_hour: null, seven_day: null, fable_weekly: null },
      observed_at: null,
      blocked: null,
      active_sessions: 0,
    }],
    pool: {
      total_count: 1,
      available_count: 1,
      best_weekly_remaining_percent: null,
      best_weekly_resets_at: null,
      earliest_available_at: null,
    },
    fable_pool: null,
  };
}

function loginSnapshot(state: "url_ready" | "done" = "url_ready") {
  return {
    login_id: "login-a",
    account_id: state === "done" ? ACCOUNT_ID : null,
    state,
    auth_url: "https://claude.example.test/login",
    expires_at: "2026-11-19T03:10:00.000Z",
    error: null,
  };
}

function fakeService() {
  const service: ClaudeCentralRouteService = {
    getAccountList: vi.fn(async () => accountList()),
    patchAccount: vi.fn(async () => accountList()),
    deleteAccount: vi.fn(async () => true),
    getSettings: vi.fn(async () => ({
      default_receive: true,
      nodes: {},
      effective: [],
    })),
    updateSettings: vi.fn(async () => ({
      default_receive: true,
      nodes: {},
      effective: [],
    })),
    startLogin: vi.fn(async () => loginSnapshot()),
    submitLoginCode: vi.fn(async () => loginSnapshot("done")),
    getLogin: vi.fn(() => loginSnapshot()),
    cancelLogin: vi.fn(() => ({ ...loginSnapshot(), state: "cancelled" as const })),
  };
  return service;
}

async function createHarness() {
  const service = fakeService();
  const app = createApp({ config, claudeCentralRoutes: { service } });
  return { app, service };
}

describe("central Claude HTTP routes", () => {
  it("serves the account list without tokens", async () => {
    const { app, service } = await createHarness();
    try {
      const response = await app.inject({ method: "GET", url: "/api/claude-auth/central/accounts" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual(accountList());
      expect(response.body).not.toContain("access_token");
      expect(response.body).not.toContain("refresh_token");
      expect(service.getAccountList).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("validates the account patch and passes enabled/priority through", async () => {
    const { app, service } = await createHarness();
    try {
      const invalid = await app.inject({
        method: "PATCH",
        url: `/api/claude-auth/central/accounts/${ACCOUNT_ID}`,
        payload: { email: "nope@example.com" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(service.patchAccount).not.toHaveBeenCalled();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/claude-auth/central/accounts/${ACCOUNT_ID}`,
        payload: { enabled: false, priority: null },
      });
      expect(response.statusCode).toBe(200);
      expect(service.patchAccount).toHaveBeenCalledWith(ACCOUNT_ID, { enabled: false, priority: 0 });
    } finally {
      await app.close();
    }
  });

  it("returns 404 when a deleted account does not exist", async () => {
    const { app, service } = await createHarness();
    vi.mocked(service.deleteAccount).mockResolvedValue(false);
    try {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/claude-auth/central/accounts/${ACCOUNT_ID}`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "account_not_found" });
    } finally {
      await app.close();
    }
  });

  it("exposes the login start, code submit, status, and cancel routes", async () => {
    const { app, service } = await createHarness();
    try {
      const started = await app.inject({
        method: "POST",
        url: "/api/claude-auth/central/logins",
        payload: {},
      });
      expect(started.statusCode).toBe(202);
      expect(service.startLogin).toHaveBeenCalledWith({});

      const relogin = await app.inject({
        method: "POST",
        url: "/api/claude-auth/central/logins",
        payload: { account_id: ACCOUNT_ID },
      });
      expect(relogin.statusCode).toBe(202);
      expect(service.startLogin).toHaveBeenLastCalledWith({ account_id: ACCOUNT_ID });

      const submitted = await app.inject({
        method: "POST",
        url: "/api/claude-auth/central/logins/login-a/code",
        payload: { code: "abcd#state-1" },
      });
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json()).toMatchObject({ state: "done" });
      expect(service.submitLoginCode).toHaveBeenCalledWith("login-a", "abcd#state-1");

      const status = await app.inject({ method: "GET", url: "/api/claude-auth/central/logins/login-a" });
      expect(status.statusCode).toBe(200);

      const cancelled = await app.inject({
        method: "DELETE",
        url: "/api/claude-auth/central/logins/login-a",
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({ state: "cancelled" });
    } finally {
      await app.close();
    }
  });

  it("maps login errors to their status and code", async () => {
    const { app, service } = await createHarness();
    vi.mocked(service.getLogin).mockImplementation(() => {
      throw new ClaudeCentralLoginError("login_not_found", "missing", 404);
    });
    vi.mocked(service.deleteAccount).mockRejectedValue(new ClaudeCentralNotFoundError());
    try {
      const missing = await app.inject({ method: "GET", url: "/api/claude-auth/central/logins/nope" });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: "login_not_found" });

      const notFound = await app.inject({
        method: "DELETE",
        url: `/api/claude-auth/central/accounts/${ACCOUNT_ID}`,
      });
      expect(notFound.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("passes a null node value through so the override is deleted", async () => {
    const { app, service } = await createHarness();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/claude-auth/central/settings",
        payload: { default_receive: false, nodes: { "node-a": null, "node-b": true } },
      });
      expect(response.statusCode).toBe(200);
      expect(service.updateSettings).toHaveBeenCalledWith({
        default_receive: false,
        nodes: { "node-a": null, "node-b": true },
      });

      const invalid = await app.inject({
        method: "PUT",
        url: "/api/claude-auth/central/settings",
        payload: { nodes: { "node-a": "yes" } },
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
