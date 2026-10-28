import { useMemo } from "react";
import type { ClaudeAccount, ClaudeAccountList, ClaudeAuthLoginFlow, UsageSummaryGauge, UsageSummaryNode } from "@seosoyoung/soul-ui";
import { NodeClaudeAuthGate } from "../components/NodeClaudeAuthGate";
import { PersistentSessionWeeklyUsage } from "./PersistentSessionWeeklyUsage";

const nodeId = "eiaserinnys";

function quota(used: number, reset: string) {
  return { used_percent: used, resets_at: reset };
}

function sampleAccounts(): ClaudeAccountList {
  const resetSoon = "2026-10-28T14:30:00+09:00";
  const resetWeek = "2026-10-29T14:00:00+09:00";
  const accounts: ClaudeAccount[] = [
    {
      id: "sample-main",
      email: "eiaserinnys@gmail.com",
      plan: "Max 20x",
      enabled: true,
      priority: 1,
      auth_state: "ok",
      usage: { five_hour: quota(24, resetSoon), seven_day: quota(13, resetWeek), fable_weekly: quota(18, resetWeek) },
      observed_at: "2026-10-28T09:10:00+09:00",
      blocked: null,
      active_sessions: 2,
    },
    {
      id: "sample-secondary",
      email: "eiaserinnys.sub@gmail.com",
      plan: "Max 5x",
      enabled: true,
      priority: 2,
      auth_state: "ok",
      usage: { five_hour: quota(100, resetSoon), seven_day: quota(68, resetWeek), fable_weekly: quota(82, resetWeek) },
      observed_at: "2026-10-28T09:08:00+09:00",
      blocked: { until: resetSoon, scope: "all" },
      active_sessions: 0,
    },
    {
      id: "sample-backup",
      email: "eiaserinnys.backup@gmail.com",
      plan: "Pro",
      enabled: true,
      priority: 3,
      auth_state: "idle",
      usage: { five_hour: null, seven_day: null, fable_weekly: null },
      observed_at: "2026-10-28T08:10:00+09:00",
      blocked: null,
      active_sessions: 0,
    },
    {
      id: "sample-relogin",
      email: "eiaserinnys.old@gmail.com",
      plan: "Pro",
      enabled: false,
      priority: 4,
      auth_state: "needs_relogin",
      usage: { five_hour: null, seven_day: null, fable_weekly: null },
      observed_at: null,
      blocked: null,
      active_sessions: 0,
    },
  ];
  return {
    mode: "pool",
    accounts,
    pool: {
      available_count: 2,
      total_count: 3,
      best_weekly_remaining_percent: 87,
      best_weekly_resets_at: resetWeek,
      earliest_available_at: resetSoon,
    },
    fable_pool: {
      available_count: 2,
      total_count: 3,
      best_weekly_remaining_percent: 82,
      best_weekly_resets_at: resetWeek,
      earliest_available_at: resetSoon,
    },
  };
}

function jsonData(data: unknown): Response {
  return Response.json(data);
}

export function createClaudeAccountReviewRequest(): typeof fetch {
  let list = sampleAccounts();
  let flow: ClaudeAuthLoginFlow | null = null;
  return async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === `/api/nodes/${nodeId}/claude-auth/accounts` && method === "GET") return jsonData(list);
    if (path === `/api/nodes/${nodeId}/claude-auth/logins` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { account_id?: string };
      flow = {
        login_id: "sample-login",
        account_id: body.account_id ?? null,
        state: "url_ready",
        auth_url: "https://example.invalid/claude-auth",
        expires_at: "2026-10-28T12:00:00+09:00",
        error: null,
      };
      return jsonData(flow);
    }
    if (path === `/api/nodes/${nodeId}/claude-auth/logins/sample-login` && method === "GET") return jsonData(flow);
    if (path === `/api/nodes/${nodeId}/claude-auth/logins/sample-login/code` && method === "POST") {
      flow = { ...flow!, state: "done" };
      if (!flow.account_id) {
        list = { ...list, accounts: [...list.accounts, {
          id: "sample-new",
          email: "new-account@example.test",
          plan: "Pro",
          enabled: true,
          priority: list.accounts.length + 1,
          auth_state: "ok",
          usage: { five_hour: null, seven_day: null, fable_weekly: null },
          observed_at: null,
          blocked: null,
          active_sessions: 0,
        }] };
      }
      return jsonData(flow);
    }
    if (path === `/api/nodes/${nodeId}/claude-auth/logins/sample-login` && method === "DELETE") {
      flow = { ...flow!, state: "cancelled" };
      return jsonData(flow);
    }
    const accountMatch = path.match(/\/accounts\/([^/]+)$/);
    if (accountMatch && method === "PATCH") {
      const accountId = decodeURIComponent(accountMatch[1]!);
      const body = JSON.parse(String(init?.body ?? "{}")) as { enabled?: boolean; priority?: number | null };
      list = {
        ...list,
        accounts: list.accounts.map((account) => account.id === accountId ? { ...account, ...body } : account),
      };
      return jsonData(list);
    }
    if (accountMatch && method === "DELETE") {
      const accountId = decodeURIComponent(accountMatch[1]!);
      list = { ...list, accounts: list.accounts.filter((account) => account.id !== accountId) };
      return jsonData({ deferred: false, accounts: list.accounts, pool: list.pool });
    }
    return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
  };
}

export function ClaudeAccountPoolReviewSample() {
  const request = useMemo(() => createClaudeAccountReviewRequest(), []);

  return <div className="c724-node-card" data-testid="claude-account-review-sample">
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <span className="h-2 w-2 rounded-full bg-emerald-400 shrink-0" />
      <span className="text-sm font-medium text-foreground">{nodeId}</span>
      <span className="c724-meta-inline ml-auto">에이전트 4 · 세션 2</span>
    </div>
    <NodeClaudeAuthGate nodeId={nodeId} request={request} />
  </div>;
}

const pasGauges: UsageSummaryGauge[] = [
  { id: "claude", label: "Claude", remainingPercent: 87, resetAt: 1_793_280_000 },
  { id: "fable", label: "Fable", remainingPercent: 82, resetAt: 1_793_280_000 },
  { id: "codex", label: "Codex", remainingPercent: 64, resetAt: 1_793_280_000 },
];

function pasNode(availableCount: number): UsageSummaryNode {
  const claude = {
    status: "auto" as const,
    weeklyRemainingPercent: availableCount === 0 ? null : 87,
    weeklyResetAt: availableCount === 0 ? null : 1_793_280_000,
    shortRemainingPercent: null,
    shortResetAt: null,
    quotas: [],
    mode: "pool" as const,
    accounts: [],
    pool: {
      available_count: availableCount,
      total_count: 2,
      best_weekly_remaining_percent: availableCount === 0 ? 0 : 87,
      best_weekly_resets_at: "2026-10-29T14:00:00+09:00",
      earliest_available_at: "2026-10-28T14:30:00+09:00",
    },
    fable_pool: null,
  };
  return {
    nodeId,
    fetchedAt: "2026-10-28T09:11:00+09:00",
    stale: false,
    staleSince: null,
    providers: { claude, codex: null, antigravity: null },
  };
}

export function ClaudePoolPasReviewSample({ availableCount = 2 }: { availableCount?: number }) {
  const node = pasNode(availableCount);
  const evaluatedAtMs = Date.now();
  return <div className="persistent-session-weekly-usage-review-sample">
    <div className="persistent-session-weekly-usage-review-seat">
      <PersistentSessionWeeklyUsage
        node={node}
    gauges={availableCount === 0 ? pasGauges.filter(gauge => gauge.id !== "claude") : pasGauges}
        loading={false}
        loadState="ready"
        evaluatedAtMs={evaluatedAtMs}
        onRetry={() => undefined}
        onNextNode={() => undefined}
      />
    </div>
  </div>;
}
