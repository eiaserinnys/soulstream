import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAccountService } from "../../src/claude_accounts/service.js";
import { ClaudeAccountUsageCollector } from "../../src/claude_accounts/usage.js";
import { countSelectableCandidates, selectBestCandidate } from "../../src/claude_accounts/selector.js";
import { computePoolSummary } from "../../src/claude_accounts/pool.js";
import type { ClaudeAccountUsage, ClaudeAccountView } from "../../src/claude_accounts/types.js";

const ID = "11111111-1111-4111-8111-111111111111";
const now = Date.parse("2026-10-28T01:00:00.000Z");
const reset = "2026-10-29T01:00:00.000Z";

function writeCredentials(dir: string, expiresAt: number): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "test-token", refreshToken: "test-refresh", expiresAt },
  }));
}

function usage(sevenDay: number | null = null, fable: number | null = null): ClaudeAccountUsage {
  return {
    five_hour: null,
    seven_day: sevenDay === null ? null : { used_percent: sevenDay, resets_at: reset },
    fable_weekly: fable === null ? null : { used_percent: fable, resets_at: reset },
  };
}

function account(id: string, accountUsage: ClaudeAccountUsage): ClaudeAccountView {
  return { id, email: "test@example.com", plan: "max", enabled: true, priority: null,
    auth_state: "ok", login_expires_at: null, active_sessions: 0, blocked: null, stale: false,
    observed_at: new Date(now).toISOString(), usage: accountUsage };
}

describe("standby account usage", () => {
  let root: string;
  let profileDir: string;
  const fetchUsage = () => new Response(JSON.stringify({ seven_day: { utilization: 32, resets_at: reset } }), { status: 200 });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "standby-usage-test-"));
    profileDir = path.join(root, "profile");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("returns idle immediately, then renews and fills the cache", async () => {
    writeCredentials(profileDir, now - 1000);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const renew = vi.fn(async () => { await pending; writeCredentials(profileDir, now + 3600_000); });
    const fetchImpl = vi.fn(async () => fetchUsage());
    const collector = new ClaudeAccountUsageCollector({ now: () => now, fetchImpl: fetchImpl as typeof fetch, credentialRenewer: { renew } });
    const result = await collector.collectAll([{ accountId: ID, profileDir, renewExpiredCredentials: true }]);
    expect(result.get(ID)?.auth_state).toBe("idle");
    expect(renew).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(collector.getCachedObservation(ID, profileDir)).toMatchObject({
      auth_state: "ok", observed_at: new Date(now).toISOString(), usage: { seven_day: { used_percent: 32 } },
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not renew a disabled account through the service", async () => {
    const renew = vi.fn(async () => {});
    const svc = new ClaudeAccountService({ accountsDir: path.join(root, "accounts"), homeDir: root, now: () => now, credentialRenewer: { renew } });
    const pending = await svc.createPendingDir("disabled");
    writeCredentials(pending, now - 1000);
    await svc.registerFromPending({ loginId: "disabled", id: ID, email: "test@example.com", plan: "max" });
    await svc.updateAccount(ID, { enabled: false });
    await svc.getAccountList();
    expect(renew).not.toHaveBeenCalled();
  });

  it("renews an enabled expired account when the service lists accounts", async () => {
    const renew = vi.fn(async ({ profileDir: dir }: { accountId: string; profileDir: string }) => {
      writeCredentials(dir, now + 3600_000);
    });
    const fetchImpl = vi.fn(async () => fetchUsage());
    const svc = new ClaudeAccountService({ accountsDir: path.join(root, "accounts"), homeDir: root,
      now: () => now, fetchImpl: fetchImpl as typeof fetch, credentialRenewer: { renew } });
    const pending = await svc.createPendingDir("enabled");
    writeCredentials(pending, now - 1000);
    await svc.registerFromPending({ loginId: "enabled", id: ID, email: "test@example.com", plan: "max" });
    const dir = svc.profileDir(ID)!;
    const list = await svc.getAccountList();
    expect(list.accounts[0]).toMatchObject({ auth_state: "idle", stale: false, observed_at: null, usage: usage() });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledWith({ accountId: ID, profileDir: dir });
    await vi.waitFor(() => expect(svc.usageCollector.getCachedObservation(ID, dir)).toMatchObject({ auth_state: "ok" }));
  });

  it.each(["select", "list"])("keeps an exhausted observation after expiry when %s is called first", async (first) => {
    let clock = now;
    const renew = vi.fn(async () => { throw new Error("simulated renewal failure"); });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ seven_day: { utilization: 100, resets_at: reset } }), { status: 200 }));
    const svc = new ClaudeAccountService({ accountsDir: path.join(root, "accounts"), homeDir: root,
      now: () => clock, fetchImpl: fetchImpl as typeof fetch, credentialRenewer: { renew } });
    const pending = await svc.createPendingDir("exhausted");
    writeCredentials(pending, now + 1000);
    await svc.registerFromPending({ loginId: "exhausted", id: ID, email: "test@example.com", plan: "max" });
    const initial = await svc.getAccountList();
    const observed = initial.accounts[0]!;
    expect(observed.usage.seven_day?.used_percent).toBe(100);
    clock += 1001;
    const select = () => svc.select({ session_id: "s", turn_id: "t", model: "sonnet" });
    const list = () => svc.getAccountList();
    if (first === "select") {
      expect(await select()).toMatchObject({ pool_exhausted: true, available_count: 0, earliest_available_at: reset });
      expect(renew).not.toHaveBeenCalled();
    }
    const expired = await list();
    expect(expired.accounts[0]).toMatchObject({ auth_state: "idle", stale: true,
      observed_at: observed.observed_at, usage: observed.usage });
    expect(expired.pool).toMatchObject({ available_count: 0, earliest_available_at: reset });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledWith({ accountId: ID, profileDir: svc.profileDir(ID) });
    expect(await select()).toMatchObject({ pool_exhausted: true, available_count: 0, earliest_available_at: reset });
    await expect(renew.mock.results[0]!.value).rejects.toThrow("simulated renewal failure");
  });

  it("deduplicates in-flight renewals and throttles attempts within the TTL", async () => {
    writeCredentials(profileDir, now - 1000);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const renew = vi.fn(async () => { await pending; });
    const collector = new ClaudeAccountUsageCollector({ now: () => now, credentialRenewer: { renew } });
    const input = { accountId: ID, profileDir, renewExpiredCredentials: true };
    await collector.collectAll([input]);
    await collector.collectAll([input]);
    expect(renew).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(renew).toHaveResolvedTimes(1));
    await collector.collectAll([input]);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it("does not renew a missing credential file", async () => {
    const renew = vi.fn(async () => {});
    const collector = new ClaudeAccountUsageCollector({ now: () => now, credentialRenewer: { renew } });
    await collector.collectAll([{ accountId: ID, profileDir, renewExpiredCredentials: true }]);
    expect(renew).not.toHaveBeenCalled();
  });

  it("clears an observation if the credential file or token is missing", async () => {
    const renew = vi.fn(async () => {});
    const collector = new ClaudeAccountUsageCollector({ now: () => now,
      fetchImpl: vi.fn(async () => fetchUsage()) as typeof fetch, credentialRenewer: { renew } });
    const input = { accountId: ID, profileDir, renewExpiredCredentials: true };
    writeCredentials(profileDir, now + 3600_000);
    await collector.collectAll([input]);
    fs.rmSync(path.join(profileDir, ".credentials.json"));
    expect((await collector.collectAll([input])).get(ID)).toMatchObject({
      auth_state: "idle", stale: false, observed_at: null, usage: usage(),
    });
    writeCredentials(profileDir, now + 3600_000);
    await collector.collectAll([input]);
    fs.writeFileSync(path.join(profileDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }));
    expect(collector.getCachedObservation(ID, profileDir)).toMatchObject({
      auth_state: "idle", stale: false, observed_at: null, usage: usage(),
    });
    expect(renew).not.toHaveBeenCalled();
  });

  it("fetches when credentials become valid despite a fresh idle cache", async () => {
    writeCredentials(profileDir, now - 1000);
    const fetchImpl = vi.fn(async () => fetchUsage());
    const collector = new ClaudeAccountUsageCollector({ now: () => now, fetchImpl: fetchImpl as typeof fetch });
    const input = { accountId: ID, profileDir };
    await collector.collectAll([input]);
    writeCredentials(profileDir, now + 3600_000);
    expect((await collector.collectAll([input])).get(ID)?.auth_state).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refreshes on the next five-minute poll using the default TTL", async () => {
    let clock = now;
    writeCredentials(profileDir, now + 3600_000);
    const fetchImpl = vi.fn(async () => fetchUsage());
    const collector = new ClaudeAccountUsageCollector({ now: () => clock, fetchImpl: fetchImpl as typeof fetch });
    const input = { accountId: ID, profileDir };
    await collector.collectAll([input]);
    clock += 4 * 60_000 + 1;
    await collector.collectAll([input]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("excludes exhausted windows even when stale, restores them after reset, and scopes Fable", () => {
    const exhausted = { ...account(ID, usage(100)), stale: true };
    const params = { candidates: [exhausted], model: "sonnet", nowMs: now };
    expect(selectBestCandidate(params)).toBeNull();
    expect(countSelectableCandidates(params)).toBe(0);
    expect(selectBestCandidate({ ...params, nowMs: Date.parse(reset) })).toMatchObject({ id: ID });
    const fable = { ...account(ID, usage(30, 100)), stale: true };
    expect(countSelectableCandidates({ ...params, candidates: [fable] })).toBe(1);
    expect(selectBestCandidate({ ...params, candidates: [fable], model: "fable" })).toBeNull();
  });

  it("calculates availability and the earliest of each account's latest release", () => {
    const a = account("a", usage());
    const b = account("b", usage(100));
    const c = account("c", { ...usage(100), five_hour: { used_percent: 100, resets_at: "2026-10-30T01:00:00.000Z" } });
    const observed_at = new Date(now).toISOString();
    const blocks = {
      a: { all: { observed_at, resets_at: "2026-10-31T01:00:00.000Z" } },
      c: { all: { observed_at, resets_at: "2026-11-01T01:00:00.000Z" } },
    };
    expect(computePoolSummary([a, b, c], blocks, "all", now)).toMatchObject({
      total_count: 3, available_count: 0, earliest_available_at: reset,
    });
    expect(computePoolSummary([c], blocks, "all", now).earliest_available_at).toBe("2026-11-01T01:00:00.000Z");
    expect(computePoolSummary([b], {}, "all", now).earliest_available_at).toBe(reset);
    expect(computePoolSummary([a], blocks, "all", now).earliest_available_at).toBe("2026-10-31T01:00:00.000Z");
    const unknown = account("unknown", { ...usage(100), five_hour: { used_percent: 100, resets_at: null } });
    expect(computePoolSummary([unknown], {}, "all", now).earliest_available_at).toBeNull();
  });

  it("reports pool exhaustion and reset when the only account's weekly usage is 100%", async () => {
    const svc = new ClaudeAccountService({ accountsDir: path.join(root, "accounts"), homeDir: root, now: () => now,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ seven_day: { utilization: 100, resets_at: reset } }), { status: 200 })) as typeof fetch });
    const pending = await svc.createPendingDir("single");
    writeCredentials(pending, now + 3600_000);
    await svc.registerFromPending({ loginId: "single", id: ID, email: "test@example.com", plan: "max" });
    await svc.getAccountList();
    expect(await svc.select({ session_id: "s", turn_id: "t", model: "sonnet" })).toMatchObject({
      pool_exhausted: true, available_count: 0, earliest_available_at: reset,
    });
  });
});
