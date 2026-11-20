import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeAccountService } from "../../src/claude_accounts/index.js";
import { UNMEASURED_LOCAL_USAGE_WAIT_MS } from "../../src/claude_accounts/local_usage_wait.js";
import type { ClaudeCentralPoolAccount } from "../../src/claude_accounts/types.js";
import { composeClaudeAccountServices } from "../../src/runtime/claude_runtime_composition.js";

// 카드 #1734: 노드가 재시작하면 로컬 계정의 사용량 관측이 비어 로컬이 idle로 보이고,
// 늘 ok인 중앙이 ok>idle 규칙으로 이겼다. 계정별 측정을 하나로 합치고, 시작할 때 한 번 재며,
// select는 아직 재지 않은 적격 로컬의 측정을 짧게 기다린 뒤 고른다.

const LOCAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CENTRAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CENTRAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

interface UsageReply {
  status: number;
  utilization?: number;
}

function usageResponse(reply: UsageReply): Response {
  if (reply.status !== 200) return new Response("error", { status: reply.status });
  return new Response(
    JSON.stringify({ five_hour: { utilization: reply.utilization ?? 10 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function writeCredentials(profileDir: string, expiresAt: number): void {
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(profileDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "local-token", refreshToken: "ref", expiresAt } }),
    { mode: 0o600 },
  );
}

describe("local usage warm-up after a node restart", () => {
  let root: string;
  let accountsDir: string;
  let homeDir: string;
  let nowMs: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-local-warmup-"));
    accountsDir = path.join(root, "claude-accounts");
    homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    nowMs = Date.parse("2026-11-20T01:00:00.000Z");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const centralAccount = (
    overrides: Partial<ClaudeCentralPoolAccount> = {},
  ): ClaudeCentralPoolAccount => ({
    id: CENTRAL_ID,
    email: "central@example.com",
    plan: "max",
    enabled: true,
    priority: 0,
    auth_state: "ok",
    relogin_reason: null,
    access_token: `token-${overrides.id ?? CENTRAL_ID}`,
    expires_at: new Date(nowMs + 60 * 60_000).toISOString(),
    usage_raw: { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } },
    usage_fetched_at: new Date(nowMs - 60_000).toISOString(),
    ...overrides,
  });

  const createService = (fetchImpl: unknown): ClaudeAccountService =>
    new ClaudeAccountService({
      accountsDir,
      homeDir,
      now: () => nowMs,
      fetchImpl: fetchImpl as typeof fetch,
    });

  /** 재시작 전 노드: 로컬 하나를 등록하고 중앙 스냅샷을 디스크에 남긴다. */
  async function prepareNode(
    centrals: ClaudeCentralPoolAccount[] = [
      centralAccount(),
      centralAccount({ id: OTHER_CENTRAL_ID, priority: 1 }),
    ],
  ): Promise<void> {
    const before = createService(vi.fn());
    const pending = await before.createPendingDir("login-local");
    writeCredentials(pending, nowMs + 24 * 3_600_000);
    await before.registerFromPending({
      loginId: "login-local",
      id: LOCAL_ID,
      email: "local@example.com",
      plan: "max",
    });
    if (centrals.length > 0) {
      before.applyCentralPoolSync({ revision: 1, receive: true, accounts: centrals });
    }
  }

  const selectInput = (sessionId: string, turnId = "turn-1") => ({
    session_id: sessionId,
    turn_id: turnId,
    model: "claude-sonnet-4-6",
  });

  it("waits for the local measurement on the first select after a restart and picks the local account", async () => {
    await prepareNode();
    const fetchImpl = vi.fn(async () => usageResponse({ status: 200, utilization: 10 }));
    const restarted = createService(fetchImpl);

    const selection = await restarted.select(selectInput("session-restart"));

    expect(selection).toMatchObject({ account_id: LOCAL_ID });
    expect(selection).not.toHaveProperty("source");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops waiting at the cap and picks central, then picks the local account once the measurement lands", async () => {
    await prepareNode();
    vi.useFakeTimers();
    const measurementMs = UNMEASURED_LOCAL_USAGE_WAIT_MS + 1_000;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(usageResponse({ status: 200 })), measurementMs);
    }));
    const restarted = createService(fetchImpl);

    let settled = false;
    const first = restarted.select(selectInput("session-slow")).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(UNMEASURED_LOCAL_USAGE_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await first).toMatchObject({ account_id: CENTRAL_ID, source: "central" });

    // 기다림만 멈췄고 측정은 계속 돌아 관측에 남는다.
    await vi.advanceTimersByTimeAsync(measurementMs - UNMEASURED_LOCAL_USAGE_WAIT_MS);
    const next = await restarted.select(selectInput("session-after-measurement"));
    expect(next).toMatchObject({ account_id: LOCAL_ID });
    expect(next).not.toHaveProperty("source");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends one usage request for concurrent selects that overlap the startup measurement", async () => {
    await prepareNode();
    const pending: Array<() => void> = [];
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      pending.push(() => resolve(usageResponse({ status: 200 })));
    }));
    const restarted = createService(fetchImpl);

    restarted.startLocalUsageWarmup();
    const selections = Promise.all(
      ["a", "b", "c"].map((id) => restarted.select(selectInput(`session-${id}`))),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    for (const release of pending) release();

    for (const selection of await selections) {
      expect(selection).toMatchObject({ account_id: LOCAL_ID });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends one usage request for concurrent selects without a startup measurement", async () => {
    await prepareNode();
    const fetchImpl = vi.fn(async () => usageResponse({ status: 200 }));
    const restarted = createService(fetchImpl);

    const selections = await Promise.all(
      ["a", "b"].map((id) => restarted.select(selectInput(`session-${id}`))),
    );

    expect(selections.map((selection) => "account_id" in selection && selection.account_id))
      .toEqual([LOCAL_ID, LOCAL_ID]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("records relogin and picks central when the local usage request returns %i", async (status) => {
    await prepareNode();
    const fetchImpl = vi.fn(async () => usageResponse({ status }));
    const restarted = createService(fetchImpl);

    expect(await restarted.select(selectInput("session-rejected")))
      .toMatchObject({ account_id: CENTRAL_ID, source: "central" });
    expect(restarted.store.readRelogin()[LOCAL_ID]).toMatchObject({ reason: "usage_rejected" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("picks central when the local account measures at the 98% soft cap", async () => {
    await prepareNode();
    const fetchImpl = vi.fn(async () => usageResponse({ status: 200, utilization: 98 }));
    const restarted = createService(fetchImpl);

    expect(await restarted.select(selectInput("session-capped")))
      .toMatchObject({ account_id: CENTRAL_ID, source: "central" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  interface NoWaitCase {
    name: string;
    centrals?: () => ClaudeCentralPoolAccount[];
    arrange?: (svc: ClaudeAccountService, profileDir: string) => Promise<void> | void;
    input?: Partial<ReturnType<typeof selectInput>> & { exclude_ids?: string[] };
    expected: string;
  }

  const noWaitCases: NoWaitCase[] = [
    {
      name: "an already measured local",
      arrange: async (svc) => {
        await svc.getAccountList();
      },
      expected: LOCAL_ID,
    },
    {
      name: "a local without credentials",
      arrange: (_svc, profileDir) => fs.rmSync(path.join(profileDir, ".credentials.json")),
      expected: CENTRAL_ID,
    },
    {
      name: "an expired local",
      arrange: (_svc, profileDir) => writeCredentials(profileDir, nowMs - 1_000),
      expected: CENTRAL_ID,
    },
    {
      name: "a disabled local",
      arrange: (svc) => svc.store.writeAccounts(
        svc.store.readAccounts().map((account) => ({ ...account, enabled: false })),
      ),
      expected: CENTRAL_ID,
    },
    {
      name: "a local that needs relogin",
      arrange: (svc) => svc.markNeedsRelogin(LOCAL_ID, "login_failed"),
      expected: CENTRAL_ID,
    },
    {
      name: "a local that is logging in",
      arrange: (svc) => svc.beginRelogin(LOCAL_ID, new Date(nowMs + 600_000).toISOString()),
      expected: CENTRAL_ID,
    },
    {
      name: "a local blocked for the model",
      arrange: (svc) => svc.reject({
        account_id: LOCAL_ID,
        scope: "all",
        resets_at: new Date(nowMs + 3_600_000).toISOString(),
        observed_at: new Date(nowMs).toISOString(),
      }),
      expected: CENTRAL_ID,
    },
    {
      name: "a local hidden by a same-id central copy",
      centrals: () => [centralAccount({ id: LOCAL_ID })],
      expected: LOCAL_ID,
    },
    {
      name: "an excluded local",
      input: { exclude_ids: [LOCAL_ID] },
      expected: CENTRAL_ID,
    },
    {
      name: "a same-turn reselect of an eligible bound central account",
      arrange: (svc) => svc.store.writeBindings({
        "session-no-wait": { account_id: CENTRAL_ID, turn_id: "turn-1" },
      }),
      expected: CENTRAL_ID,
    },
  ];

  it.each(noWaitCases)("sends no usage request before selecting with $name", async (testCase) => {
    await prepareNode(testCase.centrals?.());
    const fetchImpl = vi.fn(async () => usageResponse({ status: 200 }));
    const restarted = createService(fetchImpl);
    await testCase.arrange?.(restarted, restarted.store.profileDir(LOCAL_ID));
    fetchImpl.mockClear();

    const selection = await restarted.select({
      ...selectInput("session-no-wait"),
      ...testCase.input,
    });

    expect(selection).toMatchObject({ account_id: testCase.expected });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("after composing the account services", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    const compose = () => composeClaudeAccountServices({
      CLAUDE_AUTH_TOKEN_PATH: undefined,
      CLAUDE_ACCOUNT_POOL_ENABLED: true,
      CLAUDE_ACCOUNTS_DIR: accountsDir,
    }, pino({ level: "silent" }));

    it("measures local usage once and starts even when that request fails", async () => {
      await prepareNode([]);
      vi.stubEnv("HOME", homeDir);
      const fetchSpy = vi.fn(async () => {
        throw new Error("network down");
      });
      vi.stubGlobal("fetch", fetchSpy);

      const { claudeAccounts } = compose();

      expect(claudeAccounts).toBeDefined();
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      // 실패한 측정은 일시 실패(stale)로 남고, 서비스는 다시 재지 않고 바로 고른다.
      expect(await claudeAccounts!.select(selectInput("session-after-startup")))
        .toMatchObject({ account_id: LOCAL_ID });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("lets the first select join the startup measurement", async () => {
      await prepareNode();
      vi.stubEnv("HOME", homeDir);
      const fetchSpy = vi.fn(async () => usageResponse({ status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);

      const { claudeAccounts } = compose();

      expect(await claudeAccounts!.select(selectInput("session-first")))
        .toMatchObject({ account_id: LOCAL_ID });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
