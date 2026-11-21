import { describe, expect, it, vi } from "vitest";

import { ANTHROPIC_PROFILE_URL } from "@soulstream/wire-schema/claude-oauth";
import {
  ClaudeCentralLoginError,
  ClaudeCentralLoginService,
  type ClaudeCentralProfileFetcher,
  type ClaudeCentralTokenExchange,
} from "../src/claude_central/login_service.js";
import {
  CENTRAL_ACCOUNT_ID,
  CENTRAL_NOW_MS,
  InMemoryClaudeCentralAccountRepository,
  centralAccountRecord,
} from "./claude-central-test-support.js";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

function createLogin(repository = new InMemoryClaudeCentralAccountRepository()) {
  const tokenExchange = vi.fn<ClaudeCentralTokenExchange>(async () => ({
    statusCode: 200,
    body: {
      access_token: "login-access-token",
      refresh_token: "login-refresh-token",
      expires_in: 3600,
      scope: "user:profile",
    },
  }));
  const fetchProfile = vi.fn<ClaudeCentralProfileFetcher>(async () => ({
    status: 200,
    body: {
      account: { uuid: CENTRAL_ACCOUNT_ID },
      email: "central@example.com",
      plan: "max",
    },
  }));
  const service = new ClaudeCentralLoginService({
    repository,
    clientId: () => "claude-client-id",
    pkce: {
      generateVerifier: () => "verifier-1",
      generateChallenge: () => "challenge-1",
      generateState: () => "state-1",
    },
    tokenExchange,
    fetchProfile,
    now: () => CENTRAL_NOW_MS,
  });
  return { service, repository, tokenExchange, fetchProfile };
}

describe("central Claude login", () => {
  it("starts a headless copy-code login and stores the profile account after the code exchange", async () => {
    const { service, repository, tokenExchange, fetchProfile } = createLogin();

    const started = await service.start();
    expect(started).toMatchObject({ state: "url_ready", account_id: null, error: null });
    expect(started.auth_url).toContain("https://claude.com/cai/oauth/authorize?");
    expect(started.auth_url).toContain("code=true");
    expect(started.auth_url).toContain("code_challenge=challenge-1");
    expect(started.auth_url).toContain("redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback");
    expect(started.auth_url).toContain("state=state-1");

    const done = await service.submitCode(started.login_id, "the-code#state-1");
    expect(done).toMatchObject({
      login_id: started.login_id,
      account_id: CENTRAL_ACCOUNT_ID,
      state: "done",
      error: null,
    });

    expect(tokenExchange).toHaveBeenCalledTimes(1);
    expect(tokenExchange.mock.calls[0]?.[0]).toEqual({
      url: TOKEN_URL,
      data: {
        grant_type: "authorization_code",
        client_id: "claude-client-id",
        code: "the-code",
        redirect_uri: "https://platform.claude.com/oauth/code/callback",
        code_verifier: "verifier-1",
        state: "state-1",
      },
    });
    expect(fetchProfile).toHaveBeenCalledWith(ANTHROPIC_PROFILE_URL, {
      Authorization: "Bearer login-access-token",
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    });

    const stored = await repository.findById(CENTRAL_ACCOUNT_ID);
    expect(stored).toMatchObject({
      id: CENTRAL_ACCOUNT_ID,
      email: "central@example.com",
      plan: "max",
      authState: "ok",
      accessToken: "login-access-token",
      refreshToken: "login-refresh-token",
      tokenLifetimeSec: 3600,
      expiresAt: new Date(CENTRAL_NOW_MS + 3600_000).toISOString(),
      reloginReason: null,
    });
  });

  it("treats the same profile uuid as a re-login: no extra row, auth_state back to ok", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([
      centralAccountRecord({
        authState: "needs_relogin",
        reloginReason: "refresh_rejected",
        accessToken: null,
        refreshToken: "stale-refresh-token",
      }),
    ]);
    const { service } = createLogin(repository);

    const started = await service.start({ account_id: CENTRAL_ACCOUNT_ID });
    expect(started.account_id).toBe(CENTRAL_ACCOUNT_ID);
    expect(started.state).toBe("url_ready");

    const done = await service.submitCode(started.login_id, "the-code");
    expect(done.state).toBe("done");

    expect(repository.accounts.size).toBe(1);
    const stored = await repository.findById(CENTRAL_ACCOUNT_ID);
    expect(stored).toMatchObject({
      authState: "ok",
      reloginReason: null,
      accessToken: "login-access-token",
      refreshToken: "login-refresh-token",
    });
  });

  it("rejects a pasted code whose state does not match the started flow", async () => {
    const { service, tokenExchange } = createLogin();
    const started = await service.start();

    await expect(service.submitCode(started.login_id, "the-code#other-state"))
      .rejects.toMatchObject({ code: "invalid_code" });
    expect(tokenExchange).not.toHaveBeenCalled();
  });

  it("fails the flow when the profile has no account uuid", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository();
    const noUuid = new ClaudeCentralLoginService({
      repository,
      clientId: () => "claude-client-id",
      pkce: {
        generateVerifier: () => "verifier-1",
        generateChallenge: () => "challenge-1",
        generateState: () => "state-1",
      },
      tokenExchange: async () => ({
        statusCode: 200,
        body: { access_token: "login-access-token", expires_in: 3600 },
      }),
      fetchProfile: async () => ({ status: 200, body: { email: "central@example.com" } }),
      now: () => CENTRAL_NOW_MS,
    });

    const started = await noUuid.start();
    await expect(noUuid.submitCode(started.login_id, "the-code"))
      .rejects.toMatchObject({ code: "account_uuid_missing", statusCode: 502 });
    expect(noUuid.status(started.login_id)).toMatchObject({
      state: "failed",
      error: { code: "account_uuid_missing" },
    });
    expect(repository.accounts.size).toBe(0);
  });

  it("maps a refused token exchange to invalid_code and keeps the flow failed", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository();
    const service = new ClaudeCentralLoginService({
      repository,
      clientId: () => "claude-client-id",
      tokenExchange: async () => ({ statusCode: 400, text: "invalid_grant" }),
      fetchProfile: async () => ({ status: 200, body: {} }),
      now: () => CENTRAL_NOW_MS,
    });
    const started = await service.start();

    await expect(service.submitCode(started.login_id, "bad-code"))
      .rejects.toBeInstanceOf(ClaudeCentralLoginError);
    expect(service.status(started.login_id)).toMatchObject({
      state: "failed",
      error: { code: "invalid_code" },
    });
  });

  it("cancels a login and reports it as cancelled", async () => {
    const { service } = createLogin();
    const started = await service.start();

    expect(service.cancel(started.login_id)).toMatchObject({ state: "cancelled" });
    expect(service.status(started.login_id)).toMatchObject({ state: "cancelled" });
  });
});
