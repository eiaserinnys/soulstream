import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAccountService } from "../../src/claude_accounts/index.js";
import {
  selectBestCandidate,
  type SelectableAccountCandidate,
} from "../../src/claude_accounts/selector.js";

const ACC_A = "11111111-1111-4111-8111-111111111111";
const ACC_B = "22222222-2222-4222-8222-222222222222";
const USAGE_OK = { five_hour: { utilization: 10, resets_at: "2026-10-28T05:00:00.000Z" } };

function writeCredentials(profileDir: string, accessToken: string, expiresAt: number): void {
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(profileDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: "ref-secret", expiresAt } }),
    { mode: 0o600 },
  );
}

describe("ClaudeAccountService needs_relogin pool exclusion", () => {
  let root: string;
  let accountsDir: string;
  let homeDir: string;
  let nowMs: number;
  let usageStatus: number;
  let renewImpl: (input: { accountId: string; profileDir: string }) => void;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-relogin-pool-"));
    accountsDir = path.join(root, "claude-accounts");
    homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    nowMs = Date.parse("2026-10-28T01:00:00.000Z");
    usageStatus = 200;
    renewImpl = () => undefined;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createService(): ClaudeAccountService {
    const fetchImpl = vi.fn(async () => usageStatus === 200
      ? new Response(JSON.stringify(USAGE_OK), { status: 200 })
      : new Response("error", { status: usageStatus }));
    return new ClaudeAccountService({
      accountsDir,
      homeDir,
      now: () => nowMs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      credentialRenewer: { renew: async (input) => renewImpl(input) },
    });
  }

  async function register(
    svc: ClaudeAccountService,
    id: string,
    expiresAt: number,
    priority: number | null,
  ): Promise<void> {
    const pending = await svc.createPendingDir(`login-${id}`);
    writeCredentials(pending, `tok-${id}`, expiresAt);
    await svc.registerFromPending({ loginId: `login-${id}`, id, email: `${id}@example.com`, plan: null });
    await svc.updateAccount(id, { priority });
  }

  const selectInput = (sessionId: string) => ({
    session_id: sessionId,
    turn_id: `turn-${sessionId}`,
    model: "claude-sonnet-4-5",
  });

  function authStateOf(list: Awaited<ReturnType<ClaudeAccountService["getAccountList"]>>, id: string) {
    return list.accounts.find((acc) => acc.id === id)?.auth_state;
  }

  it("takes an account whose renewal left credentials expired out of selection until a later renewal succeeds", async () => {
    const svc = createService();
    await register(svc, ACC_A, nowMs - 1000, 1);
    await register(svc, ACC_B, nowMs + 7200_000, 2);

    await svc.getAccountList({ forceRefresh: true });
    await vi.waitFor(() => {
      expect(fs.existsSync(svc.store.reloginFilePath)).toBe(true);
    });
    expect(svc.store.readRelogin()[ACC_A]?.reason).toBe("renewal_failed");
    expect(authStateOf(await svc.getAccountList(), ACC_A)).toBe("needs_relogin");
    const picked = await svc.select(selectInput("s1"));
    expect(picked).toMatchObject({ account_id: ACC_B });
    await svc.release({ session_id: "s1", clear_all: true });

    renewImpl = ({ profileDir }) => writeCredentials(profileDir, `tok-${ACC_A}`, nowMs + 7200_000);
    nowMs += 6 * 60_000;
    // B의 자격이 만료되지 않도록 함께 연장한다.
    writeCredentials(svc.profileDir(ACC_B)!, `tok-${ACC_B}`, nowMs + 7200_000);
    await svc.getAccountList({ forceRefresh: true });
    await vi.waitFor(() => {
      expect(svc.store.readRelogin()[ACC_A]).toBeUndefined();
    });
    expect(authStateOf(await svc.getAccountList(), ACC_A)).toBe("ok");
    const again = await svc.select(selectInput("s2"));
    expect(again).toMatchObject({ account_id: ACC_A });
  });

  it("keeps needs_relogin across a service restart", async () => {
    const svc = createService();
    await register(svc, ACC_A, nowMs + 7200_000, 1);
    usageStatus = 401;
    expect(authStateOf(await svc.getAccountList({ forceRefresh: true }), ACC_A)).toBe("needs_relogin");
    expect(svc.store.readRelogin()[ACC_A]?.reason).toBe("usage_rejected");

    const restarted = createService();
    const result = await restarted.select(selectInput("s1"));
    expect(result).toMatchObject({ pool_exhausted: true });
  });

  it("takes an account reported with a session authentication failure out of selection", async () => {
    const svc = createService();
    await register(svc, ACC_A, nowMs + 7200_000, 1);
    await register(svc, ACC_B, nowMs + 7200_000, 2);
    await svc.getAccountList({ forceRefresh: true });

    await svc.reportAuthFailure({
      account_id: ACC_A,
      session_id: "s1",
      observed_at: new Date(nowMs).toISOString(),
    });

    expect(svc.store.readRelogin()[ACC_A]?.reason).toBe("session_auth_failed");
    expect(authStateOf(await svc.getAccountList(), ACC_A)).toBe("needs_relogin");
    expect(await svc.select(selectInput("s2"))).toMatchObject({ account_id: ACC_B });
  });
});

describe("selectBestCandidate auth ordering", () => {
  it("prefers a measured ok account over an idle account with a smaller priority number", () => {
    const base = { enabled: true, active_sessions: 0, usage: { five_hour: null, seven_day: null, fable_weekly: null } };
    const idle: SelectableAccountCandidate = { ...base, id: "idle", priority: 1, auth_state: "idle" };
    const ok: SelectableAccountCandidate = {
      ...base,
      id: "ok",
      priority: 5,
      auth_state: "ok",
      usage: { five_hour: { used_percent: 10, resets_at: null }, seven_day: null, fable_weekly: null },
    };
    const chosen = selectBestCandidate({
      candidates: [idle, ok],
      model: "claude-sonnet-4-5",
      nowMs: Date.parse("2026-10-28T01:00:00.000Z"),
    });
    expect(chosen?.id).toBe("ok");
  });
});
