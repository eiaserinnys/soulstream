import { describe, expect, it } from "vitest";

import { InMemoryNodeRegistry } from "../src/index.js";
import { ClaudeCentralService } from "../src/claude_central/service.js";
import {
  CENTRAL_NOW_MS,
  InMemoryClaudeCentralAccountRepository,
  InMemoryClaudeCentralSettingsRepository,
  centralAccountRecord,
  jsonResponse,
} from "./claude-central-test-support.js";

type Usage = { fiveHour?: number; sevenDay?: number };

const RESET_FUTURE = new Date(CENTRAL_NOW_MS + 60 * 60_000).toISOString();

function usageBody(usage: Usage) {
  return {
    five_hour: { utilization: usage.fiveHour ?? 0, resets_at: RESET_FUTURE },
    seven_day: { utilization: usage.sevenDay ?? 0, resets_at: RESET_FUTURE },
  };
}

async function harness(
  accounts: ReadonlyArray<{ id: string; token: string; usage?: Usage; override?: AccountOverride }>,
) {
  const repository = new InMemoryClaudeCentralAccountRepository(accounts.map((account, index) =>
    centralAccountRecord({
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      email: `${account.id}@example.com`,
      accessToken: account.token,
      ...account.override,
    })));
  const usageByToken = new Map(accounts.map((account) => [account.token, account.usage ?? {}]));
  const service = new ClaudeCentralService({
    repository,
    settingsRepository: new InMemoryClaudeCentralSettingsRepository(),
    registry: new InMemoryNodeRegistry({ nowMs: () => CENTRAL_NOW_MS }),
    bridge: { sendPendingCommand: async () => ({}) as never },
    clientId: () => "client",
    notifyRelogin: () => undefined,
    now: () => CENTRAL_NOW_MS,
    fetch: (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const token = init?.headers?.Authorization?.replace("Bearer ", "") ?? "";
      return jsonResponse(usageBody(usageByToken.get(token) ?? {}));
    }) as typeof fetch,
  });
  await service.usage.runOnce();
  return service;
}

type AccountOverride = Partial<ReturnType<typeof centralAccountRecord>>;

describe("central Claude one-shot token", () => {
  it("picks the account with the lowest seven-day usage, breaking ties on the five-hour usage", async () => {
    const service = await harness([
      { id: "busy", token: "token-busy", usage: { sevenDay: 60 } },
      { id: "calm-hot", token: "token-calm-hot", usage: { sevenDay: 10, fiveHour: 50 } },
      { id: "calm-cool", token: "token-calm-cool", usage: { sevenDay: 10, fiveHour: 5 } },
    ]);
    await expect(service.pickOneShotAccessToken()).resolves.toBe("token-calm-cool");
  });

  it("skips disabled, needs_relogin, nearly expired and exhausted accounts", async () => {
    const service = await harness([
      { id: "disabled", token: "token-disabled", usage: { sevenDay: 1 }, override: { enabled: false } },
      { id: "relogin", token: "token-relogin", usage: { sevenDay: 1 }, override: { authState: "needs_relogin" } },
      {
        id: "expiring", token: "token-expiring", usage: { sevenDay: 1 },
        override: { expiresAt: new Date(CENTRAL_NOW_MS + 30_000).toISOString() },
      },
      { id: "exhausted", token: "token-exhausted", usage: { sevenDay: 100 } },
      { id: "usable", token: "token-usable", usage: { sevenDay: 80 } },
    ]);
    await expect(service.pickOneShotAccessToken()).resolves.toBe("token-usable");
  });

  it("returns null when no account qualifies", async () => {
    const service = await harness([
      { id: "exhausted", token: "token-exhausted", usage: { fiveHour: 100 } },
    ]);
    await expect(service.pickOneShotAccessToken()).resolves.toBeNull();
  });
});
