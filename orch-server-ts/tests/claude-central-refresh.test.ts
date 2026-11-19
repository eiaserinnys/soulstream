import { describe, expect, it, vi } from "vitest";

import {
  ClaudeCentralTokenRefreshService,
  MIN_REFRESH_MARGIN_MS,
  isCentralRefreshDue,
} from "../src/claude_central/token_refresh_service.js";
import type { ClaudeCentralAccountRecord } from "../src/claude_central/types.js";
import {
  CENTRAL_ACCOUNT_ID,
  CENTRAL_NOW_MS,
  InMemoryClaudeCentralAccountRepository,
  centralAccountRecord,
  jsonResponse,
} from "./claude-central-test-support.js";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

function expiresIn(ms: number): string {
  return new Date(CENTRAL_NOW_MS + ms).toISOString();
}

function createRefresh(
  repository: InMemoryClaudeCentralAccountRepository,
  fetchImpl: typeof fetch,
  callbacks: {
    onRefreshed?: (account: ClaudeCentralAccountRecord) => void;
    onRejected?: (account: ClaudeCentralAccountRecord) => void;
    onWarning?: (message: string, error?: unknown) => void;
  } = {},
) {
  return new ClaudeCentralTokenRefreshService({
    repository,
    clientId: () => "claude-client-id",
    fetch: fetchImpl,
    tokenUrl: TOKEN_URL,
    now: () => CENTRAL_NOW_MS,
    ...(callbacks.onRefreshed === undefined ? {} : { onRefreshed: callbacks.onRefreshed }),
    ...(callbacks.onRejected === undefined ? {} : { onRejected: callbacks.onRejected }),
    ...(callbacks.onWarning === undefined ? {} : { onWarning: callbacks.onWarning }),
  });
}

describe("central Claude token refresh", () => {
  it("refreshes when the remaining life drops under half the token lifetime", () => {
    const base = centralAccountRecord({ tokenLifetimeSec: 7200 });
    expect(isCentralRefreshDue({ ...base, expiresAt: expiresIn(2 * 3600_000) }, CENTRAL_NOW_MS)).toBe(false);
    expect(isCentralRefreshDue({ ...base, expiresAt: expiresIn(3600_000) }, CENTRAL_NOW_MS)).toBe(false);
    expect(isCentralRefreshDue({ ...base, expiresAt: expiresIn(3600_000 - 1) }, CENTRAL_NOW_MS)).toBe(true);
  });

  it("keeps the 30 minute floor for short-lived tokens", () => {
    const base = centralAccountRecord({ tokenLifetimeSec: 600 });
    expect(MIN_REFRESH_MARGIN_MS).toBe(30 * 60_000);
    expect(isCentralRefreshDue({ ...base, expiresAt: expiresIn(30 * 60_000) }, CENTRAL_NOW_MS)).toBe(false);
    expect(isCentralRefreshDue({ ...base, expiresAt: expiresIn(30 * 60_000 - 1) }, CENTRAL_NOW_MS)).toBe(true);
  });

  it("treats a missing expiry as due and skips disabled, rejected, and refresh-token-less accounts", () => {
    const base = centralAccountRecord();
    expect(isCentralRefreshDue({ ...base, expiresAt: null }, CENTRAL_NOW_MS)).toBe(true);
    expect(isCentralRefreshDue({ ...base, enabled: false, expiresAt: null }, CENTRAL_NOW_MS)).toBe(false);
    expect(isCentralRefreshDue({ ...base, authState: "needs_relogin", expiresAt: null }, CENTRAL_NOW_MS)).toBe(false);
    expect(isCentralRefreshDue({ ...base, refreshToken: null, expiresAt: null }, CENTRAL_NOW_MS)).toBe(false);
  });

  it("stores the refreshed access token, rotated refresh token, and expires_in", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([
      centralAccountRecord({ expiresAt: expiresIn(60_000) }),
    ]);
    const onRefreshed = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({
      access_token: "access-token-2",
      refresh_token: "refresh-token-2",
      expires_in: 7200,
      scope: "user:profile user:inference",
    }));
    const service = createRefresh(repository, fetchImpl as unknown as typeof fetch, { onRefreshed });

    const result = await service.runOnce();
    expect(result).toEqual({ refreshed: 1, rejected: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(request[0]).toBe(TOKEN_URL);
    expect(request[1].method).toBe("POST");
    expect(JSON.parse(String(request[1].body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-token-1",
      client_id: "claude-client-id",
    });

    expect(await repository.findById(CENTRAL_ACCOUNT_ID)).toMatchObject({
      accessToken: "access-token-2",
      refreshToken: "refresh-token-2",
      tokenLifetimeSec: 7200,
      expiresAt: expiresIn(7200_000),
      refreshedAt: new Date(CENTRAL_NOW_MS).toISOString(),
      authState: "ok",
    });
    expect(onRefreshed).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing refresh token when the response omits a new one", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([
      centralAccountRecord({ expiresAt: expiresIn(60_000) }),
    ]);
    const service = createRefresh(repository, (async () => jsonResponse({
      access_token: "access-token-2",
      expires_in: 3600,
    })) as unknown as typeof fetch);

    await service.runOnce();
    expect(await repository.findById(CENTRAL_ACCOUNT_ID)).toMatchObject({
      accessToken: "access-token-2",
      refreshToken: "refresh-token-1",
    });
  });

  it("marks needs_relogin with refresh_rejected on 400 and 401", async () => {
    for (const status of [400, 401]) {
      const repository = new InMemoryClaudeCentralAccountRepository([
        centralAccountRecord({ expiresAt: expiresIn(60_000) }),
      ]);
      const onRejected = vi.fn();
      const service = createRefresh(
        repository,
        (async () => jsonResponse({ error: "invalid_grant" }, status)) as unknown as typeof fetch,
        { onRejected },
      );

      expect(await service.runOnce()).toEqual({ refreshed: 0, rejected: 1 });
      expect(await repository.findById(CENTRAL_ACCOUNT_ID)).toMatchObject({
        authState: "needs_relogin",
        reloginReason: "refresh_rejected",
        accessToken: null,
      });
      expect(onRejected).toHaveBeenCalledTimes(1);
    }
  });

  it("leaves state untouched on 5xx and network failures", async () => {
    for (const fetchImpl of [
      async () => jsonResponse({ error: "boom" }, 503),
      async () => { throw new Error("network down"); },
    ]) {
      const repository = new InMemoryClaudeCentralAccountRepository([
        centralAccountRecord({ expiresAt: expiresIn(60_000) }),
      ]);
      const onRejected = vi.fn();
      const service = createRefresh(repository, fetchImpl as unknown as typeof fetch, { onRejected });

      expect(await service.runOnce()).toEqual({ refreshed: 0, rejected: 0 });
      expect(await repository.findById(CENTRAL_ACCOUNT_ID)).toMatchObject({
        authState: "ok",
        accessToken: "access-token-1",
        refreshToken: "refresh-token-1",
      });
      expect(onRejected).not.toHaveBeenCalled();
    }
  });

  it("uses usage_rejected when the usage poll triggers the refresh", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([centralAccountRecord()]);
    const service = createRefresh(
      repository,
      (async () => jsonResponse({ error: "invalid_grant" }, 401)) as unknown as typeof fetch,
    );

    const outcome = await service.refreshAccount(CENTRAL_ACCOUNT_ID, "usage_rejected");
    expect(outcome.status).toBe("rejected");
    expect(await repository.findById(CENTRAL_ACCOUNT_ID)).toMatchObject({
      authState: "needs_relogin",
      reloginReason: "usage_rejected",
    });
  });

  it("collapses concurrent refreshes of the same account into one request", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([centralAccountRecord()]);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return jsonResponse({ access_token: "access-token-2", expires_in: 3600 });
    });
    const service = createRefresh(repository, fetchImpl as unknown as typeof fetch);

    const first = service.refreshAccount(CENTRAL_ACCOUNT_ID);
    const second = service.refreshAccount(CENTRAL_ACCOUNT_ID);
    expect(second).toBe(first);
    release?.();
    expect((await first).status).toBe("refreshed");
    expect((await second).status).toBe("refreshed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
