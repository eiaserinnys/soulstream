import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeAccountProfileSymlinkConflictError,
  ClaudeAccountService,
  type ClaudeLoginAccountPort,
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

  async function createSelectorService(
    usageMap: Record<string, unknown>,
    accountIds: string[] = [ACC_A, ACC_B],
  ): Promise<ClaudeAccountService> {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      return new Response(JSON.stringify(usageMap[token] ?? {}), {
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

    for (const [idx, id] of accountIds.entries()) {
      const loginId = `earliest-reset-${idx}`;
      const pending = await svc.createPendingDir(loginId);
      writeCredentials(pending, {
        accessToken: `tok-${id}`,
        expiresAt: nowMs + 24 * 3600_000,
      });
      await svc.registerFromPending({
        loginId,
        id,
        email: `${idx}@example.com`,
        plan: "max_20x",
      });
    }

    const list = await svc.getAccountList({ forceRefresh: true });
    for (const id of accountIds) {
      const expected = usageMap[`tok-${id}`] as {
        seven_day?: { utilization?: number };
      };
      expect(list.accounts.find((account) => account.id === id)?.usage.seven_day?.used_percent)
        .toBe(expected.seven_day?.utilization);
    }
    return svc;
  }

  it("uses the earlier applicable weekly reset before usage and Fable headroom", async () => {
    const svc = await createSelectorService({
      [`tok-${ACC_A}`]: {
        five_hour: { utilization: 20, resets_at: "2026-10-28T02:00:00.000Z" },
        seven_day: { utilization: 65, resets_at: "2026-10-29T00:00:00.000Z" },
        seven_day_fable: { utilization: 10, resets_at: "2026-11-03T00:00:00.000Z" },
      },
      [`tok-${ACC_B}`]: {
        five_hour: { utilization: 15, resets_at: "2026-10-28T02:00:00.000Z" },
        seven_day: { utilization: 15, resets_at: "2026-11-03T00:00:00.000Z" },
        seven_day_fable: { utilization: 80, resets_at: "2026-10-28T23:00:00.000Z" },
      },
    });

    const selected = await svc.select({
      session_id: "session-weekly-reset",
      turn_id: "turn-1",
      model: "claude-sonnet-4-6",
    });

    expect(selected).toMatchObject({ account_id: ACC_A });

    const selectedFable = await svc.select({
      session_id: "session-weekly-reset-fable",
      turn_id: "turn-1",
      model: "claude-fable-5-1",
    });

    expect(selectedFable).toMatchObject({ account_id: ACC_B });
  });

  it("uses the earlier five-hour reset when weekly resets are tied", async () => {
    const svc = await createSelectorService({
      [`tok-${ACC_A}`]: {
        five_hour: { utilization: 75, resets_at: "2026-10-28T02:00:00.000Z" },
        seven_day: { utilization: 15, resets_at: "2026-10-29T00:00:00.000Z" },
        seven_day_fable: { utilization: 20, resets_at: "2026-11-03T00:00:00.000Z" },
      },
      [`tok-${ACC_B}`]: {
        five_hour: { utilization: 10, resets_at: "2026-10-28T03:00:00.000Z" },
        seven_day: { utilization: 15, resets_at: "2026-10-29T00:00:00.000Z" },
        seven_day_fable: { utilization: 20, resets_at: "2026-11-03T00:00:00.000Z" },
      },
    });

    const selected = await svc.select({
      session_id: "session-five-hour-reset",
      turn_id: "turn-1",
      model: "claude-sonnet-4-6",
    });

    expect(selected).toMatchObject({ account_id: ACC_A });
  });

  it("treats a past reset as expired and prefers a future reset", async () => {
    const svc = await createSelectorService({
      [`tok-${ACC_A}`]: {
        five_hour: { utilization: 5, resets_at: "2026-10-28T02:00:00.000Z" },
        seven_day: { utilization: 5, resets_at: "2026-10-27T00:00:00.000Z" },
        seven_day_fable: { utilization: 0, resets_at: "2026-11-03T00:00:00.000Z" },
      },
      [`tok-${ACC_B}`]: {
        five_hour: { utilization: 80, resets_at: "2026-10-28T02:00:00.000Z" },
        seven_day: { utilization: 80, resets_at: "2026-10-29T00:00:00.000Z" },
        seven_day_fable: { utilization: 0, resets_at: "2026-11-03T00:00:00.000Z" },
      },
    });

    const selected = await svc.select({
      session_id: "session-expired-reset",
      turn_id: "turn-1",
      model: "claude-sonnet-4-6",
    });

    expect(selected).toMatchObject({ account_id: ACC_B });
  });

  it("keeps Fable protection and lower usage tie-breakers when resets are tied", async () => {
    const svc = await createSelectorService({
      [`tok-${ACC_A}`]: {
        five_hour: { utilization: 20, resets_at: "2026-10-29T00:00:00.000Z" },
        seven_day: { utilization: 20, resets_at: "2026-10-29T00:00:00.000Z" },
        seven_day_fable: { utilization: 5, resets_at: "2026-10-29T00:00:00.000Z" },
      },
      [`tok-${ACC_B}`]: {
        five_hour: { utilization: 10, resets_at: "2026-10-29T00:00:00.000Z" },
        seven_day: { utilization: 65, resets_at: "2026-10-29T00:00:00.000Z" },
        seven_day_fable: { utilization: 70, resets_at: "2026-10-29T00:00:00.000Z" },
      },
      [`tok-${ACC_C}`]: {
        five_hour: { utilization: 25, resets_at: "2026-10-29T00:00:00.000Z" },
        seven_day: { utilization: 55, resets_at: "2026-10-29T00:00:00.000Z" },
        seven_day_fable: { utilization: 70, resets_at: "2026-10-29T00:00:00.000Z" },
      },
    }, [ACC_A, ACC_B, ACC_C]);

    const selected = await svc.select({
      session_id: "session-tied-resets",
      turn_id: "turn-1",
      model: "claude-sonnet-4-6",
    });

    expect(selected).toMatchObject({ account_id: ACC_C });
  });

  it("implements ClaudeLoginAccountPort, creates storage directories (0700), JSON files (0600), and shared symlinks while protecting conflicts", async () => {
    const svc = new ClaudeAccountService({
      accountsDir,
      homeDir: fakeHomeDir,
      now: () => nowMs,
      fetchImpl: vi.fn(),
    });
    const loginPort: ClaudeLoginAccountPort = svc;

    expect(loginPort.profileDir(ACC_A)).toBeNull();
    expect(await loginPort.findAccount(ACC_A)).toBeNull();

    const pendingDir = await loginPort.createPendingDir("login-1");
    writeCredentials(pendingDir, { expiresAt: nowMs + 7200_000 });
    fs.writeFileSync(path.join(pendingDir, ".claude.json"), '{"oauthAccount":{}}', {
      mode: 0o600,
    });
    fs.mkdirSync(path.join(pendingDir, "sessions"), { mode: 0o700 });

    await loginPort.registerFromPending({
      loginId: "login-1",
      id: ACC_A,
      email: "a@example.com",
      plan: "max_20x",
    });

    expect(await loginPort.findAccount(ACC_A)).toEqual({
      id: ACC_A,
      email: "a@example.com",
    });
    expect(await loginPort.findByIdentity({ id: ACC_A, email: "other@example.com" })).toEqual({
      id: ACC_A,
    });
    expect(
      await loginPort.findByIdentity({
        id: "99999999-9999-4999-8999-999999999999",
        email: "A@EXAMPLE.COM",
      }),
    ).toEqual({ id: ACC_A });

    const dirMode = fs.statSync(accountsDir).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const accountsJsonMode = fs.statSync(path.join(accountsDir, "accounts.json")).mode & 0o777;
    expect(accountsJsonMode).toBe(0o600);

    const profilePath = loginPort.profileDir(ACC_A)!;
    expect(profilePath).toBe(path.join(accountsDir, "profiles", ACC_A));
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
    const pending2 = await loginPort.createPendingDir("login-2");
    writeCredentials(pending2, { expiresAt: nowMs + 7200_000 });
    const conflictPath = path.join(pending2, "projects");
    fs.mkdirSync(conflictPath, { recursive: true });
    const markerFile = path.join(conflictPath, "keep.txt");
    fs.writeFileSync(markerFile, "important-history");

    await expect(
      loginPort.registerFromPending({
        loginId: "login-2",
        id: ACC_B,
        email: "b@example.com",
        plan: "max_5x",
      }),
    ).rejects.toBeInstanceOf(ClaudeAccountProfileSymlinkConflictError);

    // Existing file in pending/profile must not be deleted
    expect(fs.existsSync(markerFile)).toBe(true);
  });

  it("selects accounts with 98% soft preference, same-turn idempotency, stale 98% non-avoidance, priority order, idle eligibility, and Fable headroom reservation", async () => {
    const usageMap: Record<string, unknown> = {
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
    const statusMap: Record<string, number> = {};

    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      const status = statusMap[token] ?? 200;
      if (status !== 200) {
        return new Response("upstream error", { status });
      }
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
        id,
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
    expect(selNonFable).toMatchObject({ account_id: ACC_B });

    // Same-turn idempotency: if ACC_B becomes >= 98% AND ACC_A gets higher priority (1 < null) mid-turn,
    // repeating select with the SAME turn_id ("turn-1") keeps ACC_B!
    usageMap[`tok-${ACC_B}`] = {
      five_hour: { utilization: 99, resets_at: "2026-10-28T06:00:00.000Z" },
      seven_day: { utilization: 35, resets_at: "2026-11-01T00:00:00.000Z" },
      seven_day_fable: { utilization: 70, resets_at: "2026-11-01T00:00:00.000Z" },
    };
    await svc.updateAccount(ACC_A, { priority: 1 });
    nowMs += 6 * 60_000;
    await svc.getAccountList({ forceRefresh: true });

    const selSameTurnAfter99 = await svc.select({
      session_id: "sess-non-fable",
      turn_id: "turn-1",
      model: "claude-sonnet-4-6",
    });
    expect(selSameTurnAfter99).toMatchObject({ account_id: ACC_B });
    expect(svc.activeSessions(ACC_B)).toBe(1);

    // On the NEXT turn ("turn-2"), 98% soft preference switches away from ACC_B (99%) to ACC_A (<98%)
    const selMovedNextTurn = await svc.select({
      session_id: "sess-non-fable",
      turn_id: "turn-2",
      model: "claude-sonnet-4-6",
    });
    expect(selMovedNextTurn).toMatchObject({ account_id: ACC_A });

    // Same-turn exclude_ids still switches immediately even within the same turn_id ("turn-2")
    await svc.updateAccount(ACC_A, { priority: null });
    usageMap[`tok-${ACC_B}`] = {
      five_hour: { utilization: 25, resets_at: "2026-10-28T06:00:00.000Z" },
      seven_day: { utilization: 35, resets_at: "2026-11-01T00:00:00.000Z" },
      seven_day_fable: { utilization: 70, resets_at: "2026-11-01T00:00:00.000Z" },
    };
    nowMs += 6 * 60_000;
    await svc.getAccountList({ forceRefresh: true });

    const selSameTurnExcluded = await svc.select({
      session_id: "sess-non-fable",
      turn_id: "turn-2",
      model: "claude-sonnet-4-6",
      exclude_ids: [ACC_A],
    });
    expect(selSameTurnExcluded).toMatchObject({ account_id: ACC_B });
    expect(selSameTurnExcluded?.available_count).toBe(2);

    // Stale 98% observation does NOT trigger 98% soft-cap avoidance:
    // Make ACC_C (at 98%) stale by returning 503 for ACC_C, and give ACC_C highest priority (1, while others are null).
    statusMap[`tok-${ACC_C}`] = 503;
    await svc.updateAccount(ACC_C, { priority: 1 });
    nowMs += 6 * 60_000;
    const staleList = await svc.getAccountList({ forceRefresh: true });
    expect(staleList.accounts.find((a) => a.id === ACC_C)?.stale).toBe(true);

    const selStaleHigh = await svc.select({
      session_id: "sess-stale-98",
      turn_id: "turn-1",
      model: "claude-sonnet-4-6",
    });
    // Because ACC_C's 98% observation is stale, it is NOT demoted to >=98% bucket, so its priority 1 wins!
    expect(selStaleHigh).toMatchObject({ account_id: ACC_C });

    // Restore ACC_C status and priority
    delete statusMap[`tok-${ACC_C}`];
    await svc.updateAccount(ACC_C, { priority: null });

    // Priority ordering among fresh <98% candidates: smaller priority number wins (ACC_B priority 1 before ACC_A priority 5)
    usageMap[`tok-${ACC_B}`] = {
      five_hour: { utilization: 25, resets_at: "2026-10-28T06:00:00.000Z" },
      seven_day: { utilization: 35, resets_at: "2026-11-01T00:00:00.000Z" },
      seven_day_fable: { utilization: 10, resets_at: "2026-11-01T00:00:00.000Z" },
    };
    await svc.updateAccount(ACC_A, { priority: 5 });
    await svc.updateAccount(ACC_B, { priority: 1 });
    nowMs += 6 * 60_000;
    await svc.getAccountList({ forceRefresh: true });

    const selPriorityOrder = await svc.select({
      session_id: "sess-priority",
      turn_id: "turn-1",
      model: "claude-fable-5-1",
    });
    expect(selPriorityOrder).toMatchObject({ account_id: ACC_B });
    const selSecondPriority = await svc.select({
      session_id: "sess-priority-2",
      turn_id: "turn-1",
      model: "claude-fable-5-1",
      exclude_ids: [ACC_B],
    });
    expect(selSecondPriority).toMatchObject({ account_id: ACC_A });
  });

  it("selects the most available account when all are above 98%, releases avoidance after reset, and keeps affinity after restart", async () => {
    const usageMap: Record<string, unknown> = {
      [`tok-${ACC_A}`]: {
        five_hour: { utilization: 20, resets_at: "2026-10-28T05:00:00.000Z" },
        seven_day: { utilization: 99.5, resets_at: "2026-11-01T00:00:00.000Z" },
      },
      [`tok-${ACC_B}`]: {
        five_hour: { utilization: 99, resets_at: "2026-10-28T06:00:00.000Z" },
        seven_day: { utilization: 35, resets_at: "2026-11-01T00:00:00.000Z" },
      },
      [`tok-${ACC_C}`]: {
        five_hour: { utilization: 98, resets_at: "2026-10-28T05:00:00.000Z" },
        seven_day: { utilization: 40, resets_at: "2026-11-01T00:00:00.000Z" },
      },
    };
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const token = ((init?.headers as Record<string, string>).Authorization).replace(/^Bearer\s+/i, "");
      return new Response(JSON.stringify(usageMap[token]), { status: 200 });
    });
    const options = { accountsDir, homeDir: fakeHomeDir, now: () => nowMs, fetchImpl: fetchImpl as unknown as typeof fetch };
    const svc = new ClaudeAccountService(options);
    for (const [idx, id] of [ACC_A, ACC_B, ACC_C].entries()) {
      const pending = await svc.createPendingDir(`high-${idx}`);
      writeCredentials(pending, { accessToken: `tok-${id}`, expiresAt: nowMs + 24 * 3600_000 });
      await svc.registerFromPending({ loginId: `high-${idx}`, id, email: `${idx}@example.com`, plan: "max" });
    }
    await svc.getAccountList({ forceRefresh: true });

    const selAllHigh = await svc.select({
      session_id: "sess-all-high", turn_id: "turn-1", model: "claude-sonnet-4-6",
    });
    expect(selAllHigh).toMatchObject({ account_id: ACC_C });

    usageMap[`tok-${ACC_A}`] = {
      five_hour: { utilization: 20, resets_at: "2026-10-28T05:00:00.000Z" },
      seven_day: { utilization: 30, resets_at: "2026-11-01T00:00:00.000Z" },
    };
    await svc.getAccountList({ forceRefresh: true });
    const bindingBeforeReset = await svc.select({
      session_id: "sess-after-reset", turn_id: "turn-1", model: "claude-sonnet-4-6",
      exclude_ids: [ACC_A, ACC_B],
    });
    expect(bindingBeforeReset).toMatchObject({ account_id: ACC_C });
    const selBeforeReset = await svc.select({
      session_id: "sess-before-reset", turn_id: "turn-1", model: "claude-sonnet-4-6",
    });
    expect(selBeforeReset).toMatchObject({ account_id: ACC_A });

    nowMs = Date.parse("2026-10-28T05:01:00.000Z");
    const selAfterReset = await svc.select({
      session_id: "sess-after-reset", turn_id: "turn-2", model: "claude-sonnet-4-6",
    });
    expect(selAfterReset).toMatchObject({ account_id: ACC_C });

    const svcRestarted = new ClaudeAccountService(options);
    const selRestartAffinity = await svcRestarted.select({
      session_id: "sess-after-reset", turn_id: "turn-3", model: "claude-sonnet-4-6",
    });
    expect(selRestartAffinity).toMatchObject({ account_id: ACC_C });
  });

  it("migrates a string binding on selection and preserves affinity after restart", async () => {
    const options = { accountsDir, homeDir: fakeHomeDir, now: () => nowMs, fetchImpl: vi.fn() };
    const svc = new ClaudeAccountService(options);
    for (const [idx, id] of [ACC_A, ACC_C].entries()) {
      const pending = await svc.createPendingDir(`binding-${idx}`);
      writeCredentials(pending, { expiresAt: nowMs + 7200_000 });
      await svc.registerFromPending({ loginId: `binding-${idx}`, id, email: `${idx}@example.com`, plan: "max" });
    }
    await svc.updateAccount(ACC_A, { priority: 1 });
    const bindingsPath = path.join(accountsDir, "bindings.json");
    const control = await svc.select({ session_id: "control", turn_id: "turn-1", model: "claude-sonnet-4-6" });
    expect(control).toMatchObject({ account_id: ACC_A });
    fs.writeFileSync(bindingsPath, JSON.stringify({ version: 1, bindings: { control: ACC_A, "legacy-session": ACC_C } }));
    const selected = await svc.select({ session_id: "legacy-session", turn_id: "turn-1", model: "claude-sonnet-4-6" });
    expect(selected).toMatchObject({ account_id: ACC_C });
    expect(JSON.parse(fs.readFileSync(bindingsPath, "utf8"))).toEqual({
      version: 1,
      bindings: {
        control: { account_id: ACC_A, turn_id: null },
        "legacy-session": { account_id: ACC_C, turn_id: "turn-1" },
      },
    });

    const restarted = new ClaudeAccountService(options);
    const selectedAfterRestart = await restarted.select({
      session_id: "legacy-session", turn_id: "turn-2", model: "claude-sonnet-4-6",
    });
    expect(selectedAfterRestart).toMatchObject({ account_id: ACC_C });
  });

  it("selects idle accounts, excludes disabled accounts from selection and total_count, and computes real service pool summary", async () => {
    // Use existing Fable weekly_scoped fixture format (from provider_usage_service.test.ts:639-647) on ACC_A
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (token === `tok-${ACC_A}`) {
        return new Response(
          JSON.stringify({
            five_hour: {
              utilization: 37,
              resets_at: "2026-10-28T14:20:00.212584+00:00",
            },
            seven_day: {
              utilization: 18,
              resets_at: "2026-11-03T22:00:00.212608+00:00",
            },
            seven_day_omelette: null,
            limits: [
              {
                kind: "weekly_scoped",
                group: "weekly",
                percent: 16,
                resets_at: "2026-11-03T22:00:00.248331+00:00",
                scope: {
                  model: {
                    id: null,
                    display_name: "Fable",
                  },
                  surface: null,
                },
                is_active: false,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("error", { status: 500 });
    });

    const svc = new ClaudeAccountService({
      accountsDir,
      homeDir: fakeHomeDir,
      now: () => nowMs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // ACC_A: ok with Fable weekly_scoped fixture
    const pDirA = await svc.createPendingDir("login-a");
    writeCredentials(pDirA, { accessToken: `tok-${ACC_A}`, expiresAt: nowMs + 7200_000 });
    await svc.registerFromPending({
      loginId: "login-a",
      id: ACC_A,
      email: "a@example.com",
      plan: "max_20x",
    });

    // ACC_B: expired credentials -> auth_state "idle" (unmeasured)
    const pDirB = await svc.createPendingDir("login-b");
    writeCredentials(pDirB, { accessToken: `tok-${ACC_B}`, expiresAt: nowMs - 1000 });
    await svc.registerFromPending({
      loginId: "login-b",
      id: ACC_B,
      email: "b@example.com",
      plan: "max_20x",
    });

    // ACC_C: registered, then we test logging_in / needs_relogin / enabled:false
    const pDirC = await svc.createPendingDir("login-c");
    writeCredentials(pDirC, { accessToken: `tok-${ACC_C}`, expiresAt: nowMs - 1000 });
    await svc.registerFromPending({
      loginId: "login-c",
      id: ACC_C,
      email: "c@example.com",
      plan: "max_20x",
    });

    // Before ACC_A is enabled, only idle/unmeasured accounts are enabled -> best_weekly_remaining_percent and resets_at are null
    await svc.updateAccount(ACC_A, { enabled: false });
    const unmeasuredList = await svc.getAccountList();
    expect(unmeasuredList.pool.total_count).toBe(2); // ACC_B and ACC_C enabled
    expect(unmeasuredList.pool.available_count).toBe(2);
    expect(unmeasuredList.pool.best_weekly_remaining_percent).toBeNull();
    expect(unmeasuredList.pool.best_weekly_resets_at).toBeNull();
    expect(unmeasuredList.fable_pool?.best_weekly_remaining_percent).toBeNull();
    expect(unmeasuredList.fable_pool?.best_weekly_resets_at).toBeNull();

    // Idle account ACC_B is actually selected when ACC_A is disabled!
    const idleSelected = await svc.select({
      session_id: "sess-idle",
      turn_id: "turn-1",
      model: "claude-sonnet-4-6",
      exclude_ids: [ACC_C],
    });
    expect(idleSelected).toMatchObject({ account_id: ACC_B });

    // Re-enable ACC_A, mark ACC_B as logging_in, mark ACC_C as needs_relogin
    await svc.updateAccount(ACC_A, { enabled: true });
    await svc.beginRelogin(ACC_B);
    await svc.endRelogin(ACC_C, "needs_relogin");

    const listWithStates = await svc.getAccountList({ forceRefresh: true });
    const accAView = listWithStates.accounts.find((a) => a.id === ACC_A)!;
    // Verify Fable weekly_scoped fixture was parsed into fable_weekly
    expect(accAView.usage).toEqual({
      five_hour: { used_percent: 37, resets_at: "2026-10-28T14:20:00.212584+00:00" },
      seven_day: { used_percent: 18, resets_at: "2026-11-03T22:00:00.212608+00:00" },
      fable_weekly: { used_percent: 16, resets_at: "2026-11-03T22:00:00.248331+00:00" },
    });

    // Pool calculation on real service:
    // All 3 are enabled -> total_count = 3.
    // ACC_B (logging_in) and ACC_C (needs_relogin) are in total_count ONLY, excluded from available_count (1).
    expect(listWithStates.pool).toEqual({
      available_count: 1,
      total_count: 3,
      best_weekly_remaining_percent: 82,
      best_weekly_resets_at: "2026-11-03T22:00:00.212608+00:00",
      earliest_available_at: null,
    });
    expect(listWithStates.fable_pool).toEqual({
      available_count: 1,
      total_count: 3,
      best_weekly_remaining_percent: 82,
      best_weekly_resets_at: "2026-11-03T22:00:00.212608+00:00",
      earliest_available_at: null,
    });

    // updateAccount(enabled: false) on ACC_C reduces total_count denominator to 2 and excludes it from select
    const updatedC = await svc.updateAccount(ACC_C, { enabled: false });
    expect(updatedC.enabled).toBe(false);
    const afterDisableC = await svc.getAccountList();
    expect(afterDisableC.pool.total_count).toBe(2);
    expect(afterDisableC.fable_pool?.total_count).toBe(2);
    const selAfterDisableC = await svc.select({
      session_id: "sess-exclude-disabled-c",
      turn_id: "turn-1",
      model: "claude-sonnet-4-6",
      exclude_ids: [ACC_A],
    });
    expect(selAfterDisableC).toMatchObject({
      pool_exhausted: true,
      available_count: 0,
      earliest_available_at: null,
    });

    // Mixed indefinite block (resets_at: null) and finite block (resets_at: ISO) on available accounts:
    await svc.endRelogin(ACC_B, "ok");
    await svc.reject({
      account_id: ACC_A,
      scope: "all",
      resets_at: null,
      observed_at: new Date(nowMs).toISOString(),
    });
    await svc.reject({
      account_id: ACC_B,
      scope: "all",
      resets_at: "2026-10-28T04:00:00.000Z",
      observed_at: new Date(nowMs).toISOString(),
    });

    const mixedBlockedList = await svc.getAccountList();
    expect(mixedBlockedList.pool.available_count).toBe(0);
    expect(mixedBlockedList.pool.earliest_available_at).toBe("2026-10-28T04:00:00.000Z");
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
        id,
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
    expect(fablePick).toMatchObject({ account_id: ACC_B });

    // Non-Fable model CAN still select ACC_A (when ACC_B is excluded)
    const nonFablePick = await svc.select({
      session_id: "s-non-fable",
      turn_id: "t1",
      model: "claude-sonnet-4-6",
      exclude_ids: [ACC_B],
    });
    expect(nonFablePick).toMatchObject({ account_id: ACC_A });

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
    expect(list.pool.available_count).toBe(0);
    expect(list.pool.earliest_available_at).toBe("2026-10-28T03:00:00.000Z");
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
      id: ACC_A,
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
    expect(selected).toMatchObject({ account_id: ACC_A });
    expect(svc.activeSessions(ACC_A)).toBe(1);

    const profileDirA = svc.profileDir(ACC_A)!;
    // Delete while active_sessions > 0 -> deferred: true, enabled becomes false immediately
    const delRes = await svc.deleteAccount(ACC_A);
    expect(delRes).toMatchObject({ id: ACC_A, deleted: true, deferred: true });
    expect(delRes.accounts[0]?.enabled).toBe(false);
    expect(delRes.pool.available_count).toBe(0);
    expect(fs.existsSync(profileDirA)).toBe(true);

    // New session cannot select disabled deferred-delete account
    const nextSel = await svc.select({
      session_id: "sess-new",
      turn_id: "t1",
      model: "claude-sonnet-4-6",
    });
    expect(nextSel).toMatchObject({
      pool_exhausted: true,
      available_count: 0,
      earliest_available_at: null,
    });

    // Release active session -> moves profileDir to retired/ and removes from accounts.json
    await svc.release({ session_id: "sess-active" });
    expect(fs.existsSync(profileDirA)).toBe(false);
    expect(svc.profileDir(ACC_A)).toBeNull();
    const retiredEntries = fs.readdirSync(path.join(accountsDir, "retired"));
    expect(retiredEntries.some((name) => name.startsWith(ACC_A))).toBe(true);
    expect(fs.readFileSync(sharedProjectFile, "utf8")).toBe("must-survive");
  });

  it("keeps a deferred delete pending after turn release while the account Query is live", async () => {
    const svc = new ClaudeAccountService({
      accountsDir,
      homeDir: fakeHomeDir,
      now: () => nowMs,
      fetchImpl: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    const pending = await svc.createPendingDir("login-query-live");
    writeCredentials(pending, { expiresAt: nowMs + 7200_000 });
    await svc.registerFromPending({
      loginId: "login-query-live",
      id: ACC_A,
      email: "query-live@example.com",
      plan: "max_20x",
    });
    const selected = await svc.select({
      session_id: "session-query-live",
      turn_id: "turn-query-live",
      model: "claude-sonnet-4-6",
    });
    expect(selected).toMatchObject({ account_id: ACC_A });

    await svc.release({
      session_id: "session-query-live",
      account_id: ACC_A,
      keep_query_active: true,
    });
    expect(svc.activeSessions(ACC_A)).toBe(1);
    const deleted = await svc.deleteAccount(ACC_A);
    expect(deleted.deferred).toBe(true);
    expect(svc.profileDir(ACC_A)).not.toBeNull();

    await svc.release({ session_id: "session-query-live", account_id: ACC_A });
    expect(svc.activeSessions(ACC_A)).toBe(0);
    expect(svc.profileDir(ACC_A)).toBeNull();
  });

  it("restores live runner occupancy only when its durable binding matches the account", async () => {
    const options = {
      accountsDir,
      homeDir: fakeHomeDir,
      now: () => nowMs,
      fetchImpl: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    };
    const original = new ClaudeAccountService(options);
    const pending = await original.createPendingDir("login-adopt");
    writeCredentials(pending, { expiresAt: nowMs + 7200_000 });
    await original.registerFromPending({
      loginId: "login-adopt",
      id: ACC_A,
      email: "adopt@example.com",
      plan: "max_20x",
    });
    await original.select({
      session_id: "session-adopt",
      turn_id: "turn-adopt",
      model: "claude-sonnet-4-6",
    });

    const restarted = new ClaudeAccountService(options);
    await expect(restarted.restoreActiveBinding({
      session_id: "session-adopt",
      account_id: ACC_A,
    })).resolves.toBeUndefined();
    expect(restarted.activeSessions(ACC_A)).toBe(1);
    await expect(restarted.restoreActiveBinding({
      session_id: "session-adopt",
      account_id: ACC_B,
    })).rejects.toThrow("binding mismatch");
  });

  it("keeps a successor turn assigned when an older Query releases the same account", async () => {
    const svc = new ClaudeAccountService({ accountsDir, homeDir: fakeHomeDir, now: () => nowMs });
    svc.store.ensureBaseDirs();
    svc.store.writeAccounts([{
      id: ACC_A, email: "a@example.com", plan: "max", enabled: true,
      priority: null, created_at: new Date(nowMs).toISOString(),
    }]);
    vi.spyOn(svc.usageCollector, "getCachedObservation").mockReturnValue({
      auth_state: "idle", stale: false, observed_at: null, lastPolledAtMs: nowMs,
      usage: { five_hour: null, seven_day: null, fable_weekly: null },
    });
    const select = (turn_id: string) => svc.select({
      session_id: "session-successor", turn_id, model: "claude-sonnet-4-6",
    });
    await select("turn-old");
    await svc.release({
      session_id: "session-successor", account_id: ACC_A,
      turn_id: "turn-old", keep_query_active: true,
    });
    await select("turn-new");
    vi.spyOn(svc.usageCollector, "collectAll").mockResolvedValue(new Map());
    const deletion = await svc.deleteAccount(ACC_A);
    expect(deletion.deferred).toBe(true);
    expect(svc.store.readBindings()["session-successor"]).toBeUndefined();
    await svc.release({ session_id: "session-successor", account_id: ACC_A, turn_id: "turn-old" });
    expect(svc.activeSessions(ACC_A)).toBe(1);
    expect(svc.profileDir(ACC_A)).not.toBeNull();
    await svc.release({ session_id: "session-successor", account_id: ACC_A, turn_id: "turn-new" });
    expect(svc.activeSessions(ACC_A)).toBe(0);
    expect(svc.profileDir(ACC_A)).toBeNull();
  });

  it("enforces 5-minute usage cache TTL, collects normal and failing accounts concurrently, and handles partial deadline", async () => {
    let accBStatus = 200;
    let hangAccB = false;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (token === `tok-${ACC_B}`) {
        if (hangAccB) {
          return await new Promise<Response>(() => {
            // Never resolves; bounded by deadlineAtMs / AbortSignal
          });
        }
        if (accBStatus !== 200) {
          return new Response("error", { status: accBStatus });
        }
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 40, resets_at: "2026-10-28T05:00:00.000Z" },
            seven_day: { utilization: 50, resets_at: "2026-11-01T00:00:00.000Z" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
      id: ACC_A,
      email: "a@example.com",
      plan: "max_20x",
    });

    const pDirB = await svc.createPendingDir("login-b");
    writeCredentials(pDirB, { accessToken: `tok-${ACC_B}`, expiresAt: nowMs + 7200_000 });
    await svc.registerFromPending({
      loginId: "login-b",
      id: ACC_B,
      email: "b@example.com",
      plan: "max_20x",
    });

    // Initial poll fetches both ACC_A and ACC_B (2 calls)
    let list = await svc.getAccountList();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(list.accounts.find((a) => a.id === ACC_A)?.stale).toBe(false);
    expect(list.accounts.find((a) => a.id === ACC_B)?.stale).toBe(false);

    // Before 5-minute TTL (4 minutes later): cache hit, no new fetch calls
    nowMs += 4 * 60_000;
    await svc.getAccountList();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // After 5-minute TTL (+1 minute + 1ms): cache miss, fetches again; ACC_A succeeds (200), ACC_B fails (503)
    accBStatus = 503;
    nowMs += 60_000 + 1;
    list = await svc.getAccountList();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(list.accounts.find((a) => a.id === ACC_A)?.stale).toBe(false);
    expect(list.accounts.find((a) => a.id === ACC_B)?.stale).toBe(true);
    expect(list.accounts.find((a) => a.id === ACC_B)?.usage.five_hour?.used_percent).toBe(40);

    // Deadline partial return: ACC_A succeeds immediately while ACC_B exceeds deadline
    hangAccB = true;
    nowMs += 6 * 60_000;
    list = await svc.getAccountList({
      forceRefresh: true,
      deadlineAtMs: Date.now() + 30,
    });
    expect(list.accounts).toHaveLength(2);
    expect(list.accounts.find((a) => a.id === ACC_A)?.stale).toBe(false);
    expect(list.accounts.find((a) => a.id === ACC_B)?.stale).toBe(true);
    expect(list.accounts.find((a) => a.id === ACC_B)?.usage.five_hour?.used_percent).toBe(40);
  });

  it("keeps credentials unchanged while collecting usage and treats a single 401 as idle", async () => {
    let status = 200;
    const fetchImpl = vi.fn(async () => status === 200
      ? new Response(JSON.stringify({ five_hour: { utilization: 15, resets_at: "2026-10-28T05:00:00.000Z" } }), { status })
      : new Response("error", { status }));
    const svc = new ClaudeAccountService({ accountsDir, homeDir: fakeHomeDir, now: () => nowMs, fetchImpl: fetchImpl as unknown as typeof fetch });
    const pending = await svc.createPendingDir("readonly");
    writeCredentials(pending, { accessToken: `tok-${ACC_A}`, expiresAt: nowMs + 7200_000 });
    await svc.registerFromPending({ loginId: "readonly", id: ACC_A, email: "a@example.com", plan: "max" });
    const credPathA = path.join(svc.profileDir(ACC_A)!, ".credentials.json");
    const credBefore = fs.readFileSync(credPathA, "utf8");

    const initial = await svc.getAccountList({ forceRefresh: true });
    expect(initial.accounts.find((a) => a.id === ACC_A)?.auth_state).toBe("ok");
    expect(initial.accounts.find((a) => a.id === ACC_A)?.usage.five_hour?.used_percent).toBe(15);
    status = 401;
    nowMs += 6 * 60_000;
    const list = await svc.getAccountList({ forceRefresh: true });
    const accA3 = list.accounts.find((a) => a.id === ACC_A)!;
    expect(accA3.auth_state).toBe("idle");
    expect(fs.readFileSync(credPathA, "utf8")).toBe(credBefore);
  });

  it("preserves a newer successful observation when an overlapping collection times out", async () => {
    let call = 0;
    let notifySlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => { notifySlowStarted = resolve; });
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 2) {
        notifySlowStarted();
        return await new Promise<Response>(() => {});
      }
      const utilization = call === 1 ? 15 : 55;
      return new Response(JSON.stringify({ five_hour: { utilization, resets_at: "2026-10-28T05:00:00.000Z" } }), { status: 200 });
    });
    const svc = new ClaudeAccountService({ accountsDir, homeDir: fakeHomeDir, now: () => nowMs, fetchImpl: fetchImpl as unknown as typeof fetch });
    const pending = await svc.createPendingDir("race");
    writeCredentials(pending, { expiresAt: nowMs + 7200_000 });
    await svc.registerFromPending({ loginId: "race", id: ACC_A, email: "a@example.com", plan: "max" });
    const initial = await svc.getAccountList({ forceRefresh: true });
    expect(initial.accounts[0]?.usage.five_hour?.used_percent).toBe(15);

    vi.useFakeTimers();
    try {
      const slow = svc.getAccountList({ forceRefresh: true, deadlineAtMs: Date.now() + 50 });
      await slowStarted;
      nowMs += 1000;
      const fast = await svc.getAccountList({ forceRefresh: true });
      expect(fast.accounts[0]?.usage.five_hour?.used_percent).toBe(55);
      expect(fast.accounts[0]?.stale).toBe(false);

      await vi.advanceTimersByTimeAsync(50);
      const timedOut = await slow;
      expect(timedOut.accounts[0]?.usage.five_hour?.used_percent).toBe(55);
      expect(timedOut.accounts[0]?.observed_at).toBe(fast.accounts[0]?.observed_at);
      expect(timedOut.accounts[0]?.stale).toBe(false);
      const cached = await svc.getAccountList();
      expect(cached.accounts[0]?.usage.five_hour?.used_percent).toBe(55);
      expect(cached.accounts[0]?.stale).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts an existing profile directory via claude auth status --json without reading credentials and defaults unknown plan to null", async () => {
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
      expect(adopted.plan).toBeNull();
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

