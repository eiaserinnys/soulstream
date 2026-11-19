import { describe, expect, it, vi } from "vitest";

import {
  ANTHROPIC_USAGE_URL,
  ClaudeCentralUsageService,
} from "../src/claude_central/usage_service.js";
import type { ClaudeCentralRefreshOutcome } from "../src/claude_central/token_refresh_service.js";
import {
  CENTRAL_ACCOUNT_ID,
  CENTRAL_NOW_MS,
  InMemoryClaudeCentralAccountRepository,
  centralAccountRecord,
  jsonResponse,
} from "./claude-central-test-support.js";

const USAGE_BODY = {
  five_hour: { utilization: 12.5, resets_at: "2026-11-19T05:00:00.000Z" },
  seven_day: { utilization: 47, resets_at: "2026-11-25T03:00:00.000Z" },
  limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 8 }],
};

type RefreshAccountFake = (
  accountId: string,
  rejectionReason?: string,
) => Promise<ClaudeCentralRefreshOutcome>;

function createUsage(
  repository: InMemoryClaudeCentralAccountRepository,
  fetchImpl: typeof fetch,
  refreshAccount: RefreshAccountFake = vi.fn(async () => ({ status: "skipped" as const })),
) {
  const onCycleComplete = vi.fn();
  const service = new ClaudeCentralUsageService({
    repository,
    tokenRefresh: { refreshAccount },
    fetch: fetchImpl,
    usageUrl: ANTHROPIC_USAGE_URL,
    now: () => CENTRAL_NOW_MS,
    onCycleComplete,
  });
  return { service, refreshAccount, onCycleComplete };
}

describe("central Claude usage", () => {
  it("keeps the raw usage body and fetch time in memory", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([centralAccountRecord()]);
    const fetchImpl = vi.fn(async () => jsonResponse(USAGE_BODY));
    const { service, onCycleComplete } = createUsage(repository, fetchImpl as unknown as typeof fetch);

    await service.runOnce();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(request[0]).toBe(ANTHROPIC_USAGE_URL);
    expect(request[1].headers).toMatchObject({
      Authorization: "Bearer access-token-1",
      "anthropic-beta": "oauth-2025-04-20",
    });
    expect(service.getObservation(CENTRAL_ACCOUNT_ID)).toEqual({
      raw: USAGE_BODY,
      fetched_at: new Date(CENTRAL_NOW_MS).toISOString(),
    });
    expect(onCycleComplete).toHaveBeenCalledTimes(1);
  });

  it("asks the token service for one refresh on 401 and stops when it is rejected", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([centralAccountRecord()]);
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "expired" }, 401));
    const refreshAccount = vi.fn(async () => ({
      status: "rejected" as const,
      account: centralAccountRecord({ authState: "needs_relogin" as const }),
    }));
    const { service } = createUsage(repository, fetchImpl as unknown as typeof fetch, refreshAccount);

    await service.runOnce();

    expect(refreshAccount).toHaveBeenCalledWith(CENTRAL_ACCOUNT_ID, "usage_rejected");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.getObservation(CENTRAL_ACCOUNT_ID)).toBeNull();
  });

  it("retries the usage request once with the refreshed token", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([centralAccountRecord()]);
    const tokens: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const authorization = (init.headers as Record<string, string>).Authorization ?? "";
      tokens.push(authorization);
      return authorization === "Bearer access-token-1"
        ? jsonResponse({ error: "expired" }, 403)
        : jsonResponse(USAGE_BODY);
    });
    const refreshAccount = vi.fn(async () => ({
      status: "refreshed" as const,
      account: centralAccountRecord({ accessToken: "access-token-2" }),
    }));
    const { service } = createUsage(repository, fetchImpl as unknown as typeof fetch, refreshAccount);

    await service.runOnce();

    expect(tokens).toEqual(["Bearer access-token-1", "Bearer access-token-2"]);
    expect(service.getObservation(CENTRAL_ACCOUNT_ID)?.raw).toEqual(USAGE_BODY);
  });

  it("skips accounts that are disabled or need a re-login", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([
      centralAccountRecord({ enabled: false }),
      centralAccountRecord({
        id: "22222222-2222-4222-8222-222222222222",
        authState: "needs_relogin",
        accessToken: null,
      }),
    ]);
    const fetchImpl = vi.fn(async () => jsonResponse(USAGE_BODY));
    const { service } = createUsage(repository, fetchImpl as unknown as typeof fetch);

    await service.runOnce();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.getObservation(CENTRAL_ACCOUNT_ID)).toBeNull();
  });
});
