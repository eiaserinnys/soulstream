import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ClaudeAccountService,
  centralTokenFingerprint,
} from "../../src/claude_accounts/index.js";
import type {
  ClaudeCentralPoolAccount,
  ClaudeCentralPoolSyncPayload,
} from "../../src/claude_accounts/types.js";

const CENTRAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CENTRAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LOCAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function writeCredentials(profileDir: string, accessToken: string, expiresAt: number): void {
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(profileDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: "ref-secret", expiresAt } }),
    { mode: 0o600 },
  );
}

describe("Claude central account pool snapshot", () => {
  let root: string;
  let accountsDir: string;
  let homeDir: string;
  let nowMs: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-central-pool-"));
    accountsDir = path.join(root, "claude-accounts");
    homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    nowMs = Date.parse("2026-11-19T01:00:00.000Z");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const centralAccount = (
    overrides: Partial<ClaudeCentralPoolAccount> = {},
  ): ClaudeCentralPoolAccount => ({
    id: CENTRAL_ID,
    email: "central@example.com",
    plan: "max",
    enabled: true,
    priority: 1,
    auth_state: "ok",
    relogin_reason: null,
    access_token: "central-token-1",
    expires_at: new Date(nowMs + 60 * 60_000).toISOString(),
    usage_raw: {
      five_hour: { utilization: 10, resets_at: new Date(nowMs + 60 * 60_000).toISOString() },
      seven_day: { utilization: 20, resets_at: new Date(nowMs + 3 * 86_400_000).toISOString() },
    },
    usage_fetched_at: new Date(nowMs - 60_000).toISOString(),
    ...overrides,
  });

  const syncPayload = (
    revision: number,
    accounts: ClaudeCentralPoolAccount[],
    receive = true,
  ): ClaudeCentralPoolSyncPayload => ({ revision, receive, accounts });

  function createService(): ClaudeAccountService {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ five_hour: { utilization: 5 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    return new ClaudeAccountService({
      accountsDir,
      homeDir,
      now: () => nowMs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  }

  async function registerLocal(
    svc: ClaudeAccountService,
    id: string,
    token: string,
  ): Promise<void> {
    const pending = await svc.createPendingDir(`login-${id}`);
    writeCredentials(pending, token, nowMs + 24 * 3_600_000);
    await svc.registerFromPending({
      loginId: `login-${id}`,
      id,
      email: `${id}@example.com`,
      plan: "max",
    });
  }

  const selectInput = (sessionId: string) => ({
    session_id: sessionId,
    turn_id: "turn-1",
    model: "claude-sonnet-4-6",
  });

  it("applies a newer revision, persists it 0600, and restores it on startup", async () => {
    const svc = createService();
    expect(svc.applyCentralPoolSync(syncPayload(3, [centralAccount()]))).toEqual({ revision: 3 });

    const snapshotPath = path.join(accountsDir, "central", "snapshot.json");
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(fs.statSync(snapshotPath).mode & 0o777).toBe(0o600);

    // 더 오래된 revision은 버린다.
    expect(
      svc.applyCentralPoolSync(syncPayload(2, [centralAccount({ email: "old@example.com" })])),
    ).toEqual({ revision: 3 });
    const live = await svc.getAccountList();
    expect(live.accounts.map((account) => [account.id, account.email, account.source]))
      .toEqual([[CENTRAL_ID, "central@example.com", "central"]]);

    const restarted = createService();
    const restored = await restarted.getAccountList();
    expect(restored.accounts.map((account) => [account.id, account.source]))
      .toEqual([[CENTRAL_ID, "central"]]);

    restarted.applyCentralPoolSync(syncPayload(4, [], false));
    expect((await restarted.getAccountList()).accounts).toEqual([]);
  });

  it("selects a central account with its token and a profile without credentials", async () => {
    const svc = createService();
    svc.applyCentralPoolSync(syncPayload(1, [centralAccount()]));

    const selection = await svc.select(selectInput("session-central"));
    expect(selection).toMatchObject({
      account_id: CENTRAL_ID,
      source: "central",
      config_dir: path.join(accountsDir, "central", "profiles", CENTRAL_ID),
      credential: { kind: "access-token", access_token: "central-token-1" },
    });

    const profileDir = path.join(accountsDir, "central", "profiles", CENTRAL_ID);
    expect(fs.existsSync(path.join(profileDir, ".credentials.json"))).toBe(false);
    expect(fs.lstatSync(path.join(profileDir, "projects")).isSymbolicLink()).toBe(true);
  });

  it("skips central accounts that are disabled, need relogin, or expire within ten minutes", async () => {
    const svc = createService();
    svc.applyCentralPoolSync(syncPayload(1, [
      centralAccount({ id: CENTRAL_ID, enabled: false }),
      centralAccount({
        id: OTHER_CENTRAL_ID,
        auth_state: "needs_relogin",
        access_token: null,
      }),
    ]));

    const expiring = await svc.select(selectInput("session-expiring"));
    expect(expiring).toMatchObject({ pool_exhausted: true });

    svc.applyCentralPoolSync(syncPayload(2, [
      centralAccount({ expires_at: new Date(nowMs + 5 * 60_000).toISOString() }),
    ]));
    const tooShort = await svc.select(selectInput("session-short"));
    expect(tooShort).toMatchObject({ pool_exhausted: true });
  });

  it("hides a same-id local account while the central snapshot is active", async () => {
    const svc = createService();
    await registerLocal(svc, LOCAL_ID, "local-token");

    const localFirst = await svc.select(selectInput("session-local"));
    expect(localFirst).toMatchObject({ account_id: LOCAL_ID });
    expect(localFirst).not.toHaveProperty("source");

    svc.applyCentralPoolSync(syncPayload(1, [centralAccount({ id: LOCAL_ID })]));
    const list = await svc.getAccountList({ forceRefresh: true });
    expect(list.accounts.map((account) => [account.id, account.source]))
      .toEqual([[LOCAL_ID, "central"]]);

    const central = await svc.select(selectInput("session-local-2"));
    expect(central).toMatchObject({
      account_id: LOCAL_ID,
      source: "central",
      credential: { access_token: "central-token-1" },
    });

    // 로컬 파일은 지우지 않는다. 중앙이 내려가면 다시 보인다.
    expect(fs.existsSync(path.join(accountsDir, "profiles", LOCAL_ID))).toBe(true);
    svc.applyCentralPoolSync(syncPayload(2, [], false));
    const restoredLocal = await svc.select(selectInput("session-local-3"));
    expect(restoredLocal).toMatchObject({ account_id: LOCAL_ID });
    expect(restoredLocal).not.toHaveProperty("source");
  });

  it("excludes a failed central token for ten minutes or until a newer token arrives", async () => {
    const svc = createService();
    svc.applyCentralPoolSync(syncPayload(1, [centralAccount()]));
    const fingerprint = centralTokenFingerprint("central-token-1")!;

    await svc.reportAuthFailure({
      account_id: CENTRAL_ID,
      session_id: "session-failed",
      observed_at: new Date(nowMs).toISOString(),
      token_fingerprint: fingerprint,
    });
    expect(fs.existsSync(path.join(accountsDir, "relogin.json"))).toBe(false);
    expect(await svc.select(selectInput("session-after-failure")))
      .toMatchObject({ pool_exhausted: true });

    // 같은 토큰이 다시 내려와도 아직 뺀 상태다.
    svc.applyCentralPoolSync(syncPayload(2, [centralAccount()]));
    expect(await svc.select(selectInput("session-after-failure-2")))
      .toMatchObject({ pool_exhausted: true });

    // 새 토큰이 오면 즉시 후보로 돌아온다.
    svc.applyCentralPoolSync(
      syncPayload(3, [centralAccount({ access_token: "central-token-2" })]),
    );
    expect(await svc.select(selectInput("session-new-token")))
      .toMatchObject({ account_id: CENTRAL_ID });

    // 실패한 토큰이 10분 지나면 다시 후보가 된다.
    await svc.reportAuthFailure({
      account_id: CENTRAL_ID,
      session_id: "session-failed-2",
      observed_at: new Date(nowMs).toISOString(),
      token_fingerprint: centralTokenFingerprint("central-token-2")!,
    });
    expect(await svc.select(selectInput("session-excluded-again")))
      .toMatchObject({ pool_exhausted: true });
    nowMs += 10 * 60_000 + 1;
    expect(await svc.select(selectInput("session-expired-exclusion")))
      .toMatchObject({ account_id: CENTRAL_ID });
  });

  it("never writes relogin.json for a central usage or renewal failure", async () => {
    const svc = createService();
    svc.applyCentralPoolSync(syncPayload(1, [centralAccount()]));
    svc.markNeedsRelogin(CENTRAL_ID, "session_auth_failed");
    expect(fs.existsSync(path.join(accountsDir, "relogin.json"))).toBe(false);
  });

  it("reports central accounts in the pool list with source, usage, and received auth state", async () => {
    const svc = createService();
    svc.applyCentralPoolSync(syncPayload(1, [
      centralAccount(),
      centralAccount({
        id: OTHER_CENTRAL_ID,
        auth_state: "needs_relogin",
        access_token: null,
        usage_raw: null,
        usage_fetched_at: null,
      }),
    ]));

    const list = await svc.getAccountList();
    const central = list.accounts.find((account) => account.id === CENTRAL_ID)!;
    expect(central.source).toBe("central");
    expect(central.auth_state).toBe("ok");
    expect(central.usage.five_hour?.used_percent).toBe(10);
    expect(central.stale).toBe(false);

    const needsRelogin = list.accounts.find((account) => account.id === OTHER_CENTRAL_ID)!;
    expect(needsRelogin).toMatchObject({
      source: "central",
      auth_state: "needs_relogin",
      stale: true,
    });
  });
});
