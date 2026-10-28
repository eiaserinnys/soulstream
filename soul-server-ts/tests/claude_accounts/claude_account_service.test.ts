import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeAccountProfileSymlinkConflictError,
  ClaudeAccountService,
  SHARED_CLAUDE_HOME_ENTRIES,
  adoptClaudeAccountProfile,
} from "../../src/claude_accounts/index.js";

const ACC_A = "11111111-1111-4111-8111-111111111111";
const ACC_B = "22222222-2222-4222-8222-222222222222";
const ACC_C = "33333333-3333-4333-8333-333333333333";

function writeCredentials(
  profileDir: string,
  options: { accessToken?: string; expiresAt?: number } = {},
): string {
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const credPath = path.join(profileDir, ".credentials.json");
  const payload = {
    claudeAiOauth: {
      accessToken: options.accessToken ?? `tok-${path.basename(profileDir)}`,
      refreshToken: "ref-secret",
      expiresAt: options.expiresAt ?? Date.now() + 3600_000,
    },
  };
  fs.writeFileSync(credPath, JSON.stringify(payload), { mode: 0o600 });
  return credPath;
}

describe("ClaudeAccountService (P2 account pool store, selector, usage, port, adopt)", () => {
  let tmpRoot: string;
  let accountsDir: string;
  let fakeHomeDir: string;
  let nowMs: number;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-accounts-test-"));
    accountsDir = path.join(tmpRoot, "claude-accounts");
    fakeHomeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(fakeHomeDir, { recursive: true, mode: 0o700 });
    nowMs = Date.parse("2026-10-28T01:00:00.000Z");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("creates storage directories (0700), JSON files (0600), and shared symlinks while protecting existing non-symlink conflicts", async () => {
    const svc = new ClaudeAccountService({
      accountsDir,
      homeDir: fakeHomeDir,
      now: () => nowMs,
      fetchImpl: vi.fn(),
    });

    const pendingDir = await svc.createPendingDir("login-1");
    writeCredentials(pendingDir, { expiresAt: nowMs + 7200_000 });
    fs.writeFileSync(path.join(pendingDir, ".claude.json"), '{"oauthAccount":{}}', {
      mode: 0o600,
    });
    fs.mkdirSync(path.join(pendingDir, "sessions"), { mode: 0o700 });

    const registered = await svc.registerFromPending({
      loginId: "login-1",
      accountUuid: ACC_A,
      email: "a@example.com",
      plan: "max_20x",
    });

    expect(registered.id).toBe(ACC_A);
    expect(registered.email).toBe("a@example.com");

    const dirMode = fs.statSync(accountsDir).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const accountsJsonMode = fs.statSync(path.join(accountsDir, "accounts.json")).mode & 0o777;
    expect(accountsJsonMode).toBe(0o600);

    const profilePath = svc.profileDir(ACC_A);
    for (const entry of SHARED_CLAUDE_HOME_ENTRIES) {
      const linkPath = path.join(profilePath, entry);
      const lstat = fs.lstatSync(linkPath);
      expect(lstat.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(linkPath)).toBe(path.join(fakeHomeDir, ".claude", entry));
    }

    // Per-profile entries remain non-symlink inside profile
    expect(fs.lstatSync(path.join(profilePath, ".credentials.json")).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(profilePath, ".claude.json")).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(profilePath, "sessions")).isSymbolicLink()).toBe(false);

    // If a non-symlink directory/file exists at a shared entry path in another profile, throw without deleting
    const pending2 = await svc.createPendingDir("login-2");
    writeCredentials(pending2, { expiresAt: nowMs + 7200_000 });
    const conflictPath = path.join(pending2, "projects");
    fs.mkdirSync(conflictPath, { recursive: true });
    const markerFile = path.join(conflictPath, "keep.txt");
    fs.writeFileSync(markerFile, "important-history");

    await expect(
      svc.registerFromPending({
        loginId: "login-2",
        accountUuid: ACC_B,
        email: "b@example.com",
        plan: "max_5x",
      }),
    ).rejects.toBeInstanceOf(ClaudeAccountProfileSymlinkConflictError);

    // Existing file in pending/profile must not be deleted
    expect(fs.existsSync(markerFile)).toBe(true);
  });

  it("selects accounts with 98% soft preference, Fable headroom reservation, affinity, priority, and no double active_sessions count", async () => {
    const usageMap: Record<
      string,
      {
        five_hour?: { utilization: number; resets_at: string };
        seven_day?: { utilization: number; resets_at: string };
        seven_day_fable?: { utilization: number; resets_at: string };
      }
    > = {
      [`tok-${ACC_A}`]: {
        five_hour: { utilization: 20, resets_at: "2026-10-28T05:00:00.000Z" },
        seven_day: { utilization: 30, resets_at: "2026-11-01T00:00:00.000Z" },
        seven_day_fable: { utilization: 10, resets_at: "2026-11-01T00:00:00.000Z" },
      },
      [`tok-${ACC_B}`]: {
        five_hour: { utilization: 25, resets_at: "2026-10-28T05:00:00.000Z" },
        seven_day: { utilization: 35, resets_at: "2026-11-01T00:00:00.000Z" },
        seven_day_fable: { utilization: 70, resets_at: "2026-11-01T00:00:00.000Z" },
      },
      [`tok-${ACC_C}`]: {
        five_hour: { utilization: 98, resets_at: "2026-10-28T05:00:00.000Z" },
        seven_day: { utilization: 40, resets_at: "2026-11-01T00:00:00.000Z" },
        seven_day_fable: { utilization: 5, resets_at: "2026-11-01T00:00:00.000Z" },
      },
    };

    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      const body = usageMap[token];
      return new Response(JSON.stringify(body ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const svc = new ClaudeAccountService({
      accountsDir,
      homeDir: fakeHomeDir,
      now: () => nowMs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    for (const [idx, id] of [ACC_A, ACC_B, ACC_C].entries()) {
      const pDir = await svc.createPendingDir(`login-${idx}`);
      writeCredentials(pDir, { accessToken: `tok-${id}`, expiresAt: nowMs + 24 * 3600_000 });
      await svc.registerFromPending({
        loginId: `login-${idx}`,
        accountUuid: id,
        email: `${idx}@example.com`,
        plan: "max_20x",
      });
    }

    await svc.getAccountList({ forceRefresh: true });

    // Non-Fable model: ACC_C is >= 98% so <98% candidates are ACC_A (fable 10%) and ACC_B (fable 70%).
    // Non-Fable prefers higher Fable usage first to preserve Fable headroom on ACC_A!
    const selNonFable = await svc.select({
      session_id: "sess-non-fable",
      turn_id: "turn-1",
      model: "claude-sonnet-4-6",
    });
    expect(selNonFable?.account_id).toBe(ACC_B);

    // Repeating select for the same session_id returns same binding and does NOT double-count active_sessions
    const selRepeat = await svc.select({
      session_id: "sess-non-fable",
      turn_id: "turn-1",
      model: "claude-sonnet-4-6",
    });
    expect(selRepeat?.account_id).toBe(ACC_B);
    expect(svc.activeSessions(ACC_B)).toBe(1);

    // Fable model: among <98% candidates (ACC_A max(20,30,10)=30 vs ACC_B max(25,35,70)=70), picks ACC_A
    const selFable = await svc.select({
      session_id: "sess-fable",
      turn_id: "turn-1",
      model: "claude-fable-5-1",
    });
    expect(selFable?.account_id).toBe(ACC_A);

    // If ACC_B becomes >= 98%, sess-non-fable (which has affinity to ACC_B) moves to ACC_A (< 98%)
    usageMap[`tok-${ACC_B}`].five_hour = {
      utilization: 99,
      resets_at: "2026-10-28T06:00:00.000Z",
    };
    nowMs += 6 * 60_000;
    await svc.getAccountList({ forceRefresh: true });

    const selMoved = await svc.select({
      session_id: "sess-non-fable",
      turn_id: "turn-2",
      model: "claude-sonnet-4-6",
    });
    expect(selMoved?.account_id).toBe(ACC_A);

    // If ALL candidates are >= 98% (and not blocked), do NOT return null; pick lowest max usage (ACC_C at 98% over ACC_B at 99%)
    usageMap[`tok-${ACC_A}`].seven_day = {
      utilization: 99.5,
      resets_at: "2026-11-01T00:00:00.000Z",
    };
    nowMs += 6 * 60_000;
    await svc.getAccountList({ forceRefresh: true });

    const selAllHigh = await svc.select({
      session_id: "sess-all-high",
      turn_id: "turn-1",
      model: "claude-sonnet-4-6",
    });
    expect(selAllHigh?.account_id).toBe(ACC_C);

    // Once ACC_C's 98% five_hour resets_at has passed, it is treated as reset (0%) even before next poll
    nowMs = Date.parse("2026-10-28T05:01:00.000Z");
    const selAfterReset = await svc.select({
      session_id: "sess-after-reset",
      turn_id: "turn-1",
      model: "claude-sonnet-4-6",
    });
    expect(selAfterReset?.account_id).toBe(ACC_C);

    // Restart persistence: a new ClaudeAccountService instance preserves bindings.json affinity
    const svcRestarted = new ClaudeAccountService({
      accountsDir,
      homeDir: fakeHomeDir,
      now: () => nowMs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const selRestartAffinity = await svcRestarted.select({
      session_id: "sess-after-reset",
      turn_id: "turn-2",
      model: "claude-sonnet-4-6",
    });
    expect(selRestartAffinity?.account_id).toBe(ACC_C);
  });

  it("isolates per-account/per-scope reject blocks, projects public blocked priority (all > fable), and computes earliest_available_at", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 40, resets_at: "2026-10-28T05:00:00.000Z" },
          seven_day: { utilization: 50, resets_at: "2026-11-01T00:00:00.000Z" },
          seven_day_fable: { utilization: 60, resets_at: "2026-11-01T00:00:00.000Z" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const svc = new ClaudeAccountService({
      accountsDir,
      homeDir: fakeHomeDir,
      now: () => nowMs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    for (const [idx, id] of [ACC_A, ACC_B].entries()) {
      const pDir = await svc.createPendingDir(`login-${idx}`);
      writeCredentials(pDir, { accessToken: `tok-${id}`, expiresAt: nowMs + 7200_000 });
      await svc.registerFromPending({
        loginId: `login-${idx}`,
        accountUuid: id,
        email: `${idx}@example.com`,
        plan: "max_20x",
      });
    }

    await svc.getAccountList({ forceRefresh: true });

    // Reject ACC_A with scope "fable" until 06:00Z
    await svc.reject({
      account_id: ACC_A,
      scope: "fable",
      resets_at: "2026-10-28T06:00:00.000Z",
      observed_at: new Date(nowMs).toISOString(),
    });

    // Fable model cannot select ACC_A -> selects ACC_B
    const fablePick = await svc.select({
      session_id: "s-fable",
      turn_id: "t1",
      model: "claude-fable-5-1",
    });
    expect(fablePick?.account_id).toBe(ACC_B);

    // Non-Fable model CAN still select ACC_A (when ACC_B is excluded)
    const nonFablePick = await svc.select({
      session_id: "s-non-fable",
      turn_id: "t1",
      model: "claude-sonnet-4-6",
      exclude_ids: [ACC_B],
    });
    expect(nonFablePick?.account_id).toBe(ACC_A);

    // Also add "all" block on ACC_A until 03:00Z (shorter than fable 06:00Z)
    await svc.reject({
      account_id: ACC_A,
      scope: "all",
      resets_at: "2026-10-28T03:00:00.000Z",
      observed_at: new Date(nowMs).toISOString(),
    });

    let list = await svc.getAccountList();
    let accAView = list.accounts.find((a) => a.id === ACC_A)!;
    // Public blocked projects "all" first while active
    expect(accAView.blocked).toEqual({
      until: "2026-10-28T03:00:00.000Z",
      scope: "all",
    });

    // Block ACC_B with "all" until 04:00Z
    await svc.reject({
      account_id: ACC_B,
      scope: "all",
      resets_at: "2026-10-28T04:00:00.000Z",
      observed_at: new Date(nowMs).toISOString(),
    });

    list = await svc.getAccountList();
    // General pool: ACC_A unblocks at 03:00Z, ACC_B at 04:00Z -> earliest is 03:00Z
    expect(list.pool.available_count).toBe(0);
    expect(list.pool.earliest_available_at).toBe("2026-10-28T03:00:00.000Z");
    // Fable pool: ACC_A has max(all=03:00Z, fable=06:00Z) = 06:00Z; ACC_B has all=04:00Z -> earliest is 04:00Z!
    expect(list.fable_pool?.available_count).toBe(0);
    expect(list.fable_pool?.earliest_available_at).toBe("2026-10-28T04:00:00.000Z");

    // Advance time to 03:30Z: ACC_A's "all" block expired, but "fable" block (06:00Z) remains active!
    nowMs = Date.parse("2026-10-28T03:30:00.000Z");
    list = await svc.getAccountList();
    accAView = list.accounts.find((a) => a.id === ACC_A)!;
    expect(accAView.blocked).toEqual({
      until: "2026-10-28T06:00:00.000Z",
      scope: "fable",
    });
    expect(list.pool.available_count).toBe(1);
    expect(list.fable_pool?.available_count).toBe(0);
    expect(list.fable_pool?.earliest_available_at).toBe("2026-10-28T04:00:00.000Z");
  });

  it("handles deferred delete on active session release without deleting shared symlink targets", async () => {
    const svc = new ClaudeAccountService({
      accountsDir,
      homeDir: fakeHomeDir,
      now: () => nowMs,
      fetchImpl: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });

    const pDir = await svc.createPendingDir("login-del");
    writeCredentials(pDir, { accessToken: `tok-${ACC_A}`, expiresAt: nowMs + 7200_000 });
    await svc.registerFromPending({
      loginId: "login-del",
      accountUuid: ACC_A,
      email: "del@example.com",
      plan: "max_20x",
    });

    const sharedProjectFile = path.join(fakeHomeDir, ".claude", "projects", "shared-note.txt");
    fs.writeFileSync(sharedProjectFile, "must-survive");

    const selected = await svc.select({
      session_id: "sess-active",
      turn_id: "t1",
      model: "claude-sonnet-4-6",
    });
    expect(selected?.account_id).toBe(ACC_A);
    expect(svc.activeSessions(ACC_A)).toBe(1);

    // Delete while active_sessions > 0 -> deferred: true, enabled becomes false immediately
    const delRes = await svc.deleteAccount(ACC_A);
    expect(delRes).toMatchObject({ id: ACC_A, deleted: true, deferred: true });
    expect(delRes.accounts[0]?.enabled).toBe(false);
    expect(delRes.pool.available_count).toBe(0);
    expect(fs.existsSync(svc.profileDir(ACC_A))).toBe(true);

    // New session cannot select disabled deferred-delete account
    const nextSel = await svc.select({
      session_id: "sess-new",
      turn_id: "t1",
      model: "claude-sonnet-4-6",
    });
    expect(nextSel).toBeNull();

    // Release active session -> moves profileDir to retired/ and removes from accounts.json
    await svc.release({ session_id: "sess-active" });
    expect(fs.existsSync(svc.profileDir(ACC_A))).toBe(false);
    const retiredEntries = fs.readdirSync(path.join(accountsDir, "retired"));
    expect(retiredEntries.some((name) => name.startsWith(ACC_A))).toBe(true);
    expect(fs.readFileSync(sharedProjectFile, "utf8")).toBe("must-survive");
  });

  it("reads .credentials.json read-only, marks expired tokens idle, keeps stale usage on 5xx, and does not permanently mark needs_relogin on single 401", async () => {
    let statusToReturn = 200;
    const fetchImpl = vi.fn(async () => {
      if (statusToReturn !== 200) {
        return new Response("error", { status: statusToReturn });
      }
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 15, resets_at: "2026-10-28T05:00:00.000Z" },
          seven_day: { utilization: 25, resets_at: "2026-11-01T00:00:00.000Z" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const svc = new ClaudeAccountService({
      accountsDir,
      homeDir: fakeHomeDir,
      now: () => nowMs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const pDirA = await svc.createPendingDir("login-a");
    writeCredentials(pDirA, { accessToken: `tok-${ACC_A}`, expiresAt: nowMs + 7200_000 });
    await svc.registerFromPending({
      loginId: "login-a",
      accountUuid: ACC_A,
      email: "a@example.com",
      plan: "max_20x",
    });

    const pDirB = await svc.createPendingDir("login-b");
    writeCredentials(pDirB, { accessToken: `tok-${ACC_B}`, expiresAt: nowMs - 1000 });
    await svc.registerFromPending({
      loginId: "login-b",
      accountUuid: ACC_B,
      email: "b@example.com",
      plan: "max_20x",
    });

    const credPathA = path.join(svc.profileDir(ACC_A), ".credentials.json");
    const credBefore = fs.readFileSync(credPathA, "utf8");

    let list = await svc.getAccountList({ forceRefresh: true });
    const accA1 = list.accounts.find((a) => a.id === ACC_A)!;
    const accB1 = list.accounts.find((a) => a.id === ACC_B)!;

    expect(accA1.auth_state).toBe("ok");
    expect(accA1.stale).toBe(false);
    expect(accA1.usage.five_hour?.used_percent).toBe(15);

    // Expired token -> idle, usage null, fetch not called for ACC_B
    expect(accB1.auth_state).toBe("idle");
    expect(accB1.usage).toEqual({ five_hour: null, seven_day: null, fable_weekly: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Transient 503 -> preserves previous usage and observed_at, sets stale = true
    statusToReturn = 503;
    nowMs += 6 * 60_000;
    list = await svc.getAccountList({ forceRefresh: true });
    const accA2 = list.accounts.find((a) => a.id === ACC_A)!;
    expect(accA2.stale).toBe(true);
    expect(accA2.usage.five_hour?.used_percent).toBe(15);
    expect(accA2.observed_at).toBe(accA1.observed_at);

    // Single 401 -> does NOT permanently mark needs_relogin (becomes idle)
    statusToReturn = 401;
    nowMs += 6 * 60_000;
    list = await svc.getAccountList({ forceRefresh: true });
    const accA3 = list.accounts.find((a) => a.id === ACC_A)!;
    expect(accA3.auth_state).toBe("idle");

    // Explicit endRelogin(ACC_A, "needs_relogin") marks needs_relogin
    await svc.endRelogin(ACC_A, "needs_relogin");
    list = await svc.getAccountList();
    expect(list.accounts.find((a) => a.id === ACC_A)?.auth_state).toBe("needs_relogin");

    // Credentials file was never modified
    expect(fs.readFileSync(credPathA, "utf8")).toBe(credBefore);
  });

  it("adopts an existing profile directory via claude auth status --json without reading or moving credentials", async () => {
    const profileDir = path.join(accountsDir, "profiles", ACC_A);
    const credPath = writeCredentials(profileDir, { accessToken: "secret-do-not-read" });
    const beforeInode = fs.statSync(credPath).ino;

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "should-be-stripped";
    process.env.ANTHROPIC_API_KEY = "should-also-be-stripped";

    try {
      const execStatus = vi.fn(async (env: NodeJS.ProcessEnv) => {
        capturedEnv = env;
        return JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          accountUuid: ACC_A,
          email: "adopted@example.com",
          subscriptionType: "max_20x",
        });
      });

      const adopted = await adoptClaudeAccountProfile({
        profilePath: profileDir,
        accountsDir,
        homeDir: fakeHomeDir,
        execAuthStatus: execStatus,
      });

      expect(adopted.id).toBe(ACC_A);
      expect(adopted.email).toBe("adopted@example.com");
      expect(adopted.plan).toBe("max_20x");
      expect(capturedEnv?.CLAUDE_CONFIG_DIR).toBe(profileDir);
      expect(capturedEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(capturedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(fs.statSync(credPath).ino).toBe(beforeInode);

      for (const entry of SHARED_CLAUDE_HOME_ENTRIES) {
        expect(fs.lstatSync(path.join(profileDir, entry)).isSymbolicLink()).toBe(true);
      }
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
