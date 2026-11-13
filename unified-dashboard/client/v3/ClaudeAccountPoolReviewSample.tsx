import { useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ClaudeAccount,
  ClaudeAccountList,
  ClaudeAuthLoginFlow,
  UsageSummaryGauge,
  UsageSummaryNode,
  UsageSummaryProvider,
  UsageSummaryQuota,
  UsageSummarySnapshot,
} from "@seosoyoung/soul-ui";
import { NodePanel } from "../components/NodePanel";
import { sampleCogitoBriefs } from "../components/CogitoNodeHealthSample";
import type { OrchestratorNode } from "../store/orchestrator-store";
import { PersistentSessionWeeklyUsage } from "./PersistentSessionWeeklyUsage";

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const nowSeconds = Math.floor(Date.now() / 1000);
const resetSoon = nowSeconds + 3 * HOUR;
const resetWeek = nowSeconds + 5 * DAY;
const resetMonth = nowSeconds + 11 * DAY;

function isoIn(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function quota(
  id: string,
  label: string,
  window: string | null,
  remainingPercent: number,
  resetAt: number | null,
): UsageSummaryQuota {
  return { id, label, window, model: null, remainingPercent, resetAt };
}

function providerOf(
  quotas: UsageSummaryQuota[],
  overrides: Partial<UsageSummaryProvider> = {},
): UsageSummaryProvider {
  return {
    status: "auto",
    weeklyRemainingPercent: null,
    weeklyResetAt: null,
    shortRemainingPercent: null,
    shortResetAt: null,
    quotas,
    ...overrides,
  };
}

function sampleAccounts(): ClaudeAccountList {
  const accounts: ClaudeAccount[] = [
    {
      id: "sample-main",
      email: "eiaserinnys@gmail.com",
      plan: "Max 20x",
      enabled: true,
      priority: 1,
      auth_state: "ok",
      usage: {
        five_hour: { used_percent: 24, resets_at: isoIn(resetSoon) },
        seven_day: { used_percent: 13, resets_at: isoIn(resetWeek) },
        fable_weekly: { used_percent: 18, resets_at: isoIn(resetWeek) },
      },
      observed_at: isoIn(nowSeconds - 6 * HOUR),
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
      usage: {
        five_hour: { used_percent: 100, resets_at: isoIn(resetSoon) },
        seven_day: { used_percent: 68, resets_at: isoIn(resetWeek) },
        fable_weekly: { used_percent: 82, resets_at: isoIn(resetWeek) },
      },
      observed_at: isoIn(nowSeconds - 8 * HOUR),
      blocked: { until: isoIn(resetSoon), scope: "all" },
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
      observed_at: isoIn(nowSeconds - 26 * HOUR),
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
      best_weekly_resets_at: isoIn(resetWeek),
      earliest_available_at: isoIn(resetSoon),
    },
    fable_pool: {
      available_count: 2,
      total_count: 3,
      best_weekly_remaining_percent: 82,
      best_weekly_resets_at: isoIn(resetWeek),
      earliest_available_at: isoIn(resetSoon),
    },
  };
}

const LEGACY_ACCOUNTS: ClaudeAccountList = { mode: "legacy", accounts: [], pool: null, fable_pool: null };

export type ProviderPanelReviewState = "pool" | "legacy" | "codex";

const NODE_BY_STATE: Record<ProviderPanelReviewState, string> = {
  pool: "sample-provider-pool",
  legacy: "sample-provider-legacy",
  codex: "sample-provider-codex",
};

/** 남은 비율이 아니라 게이지에 찍히는 사용 비율이다(5시간 38% = remaining 62). */
const CLAUDE_QUOTAS = (): UsageSummaryQuota[] => [
  quota("claude:5h", "5시간", "5h", 62, resetSoon),
  quota("claude:weekly", "7일", "7d", 66, resetWeek),
  quota("claude:weekly_scoped:fable", "Fable", "7d", 88, resetWeek),
];

const OPENCODE_QUOTAS = (): UsageSummaryQuota[] => [
  quota("opencode:short", "5시간", "5h", 75, resetSoon),
  quota("opencode:weekly", "7일", "168h", 39, resetWeek),
  quota("opencode:monthly", "월간", "monthly", 52, resetMonth),
];

// 168시간 한도 하나만 있는 공급자는 둘째 칸에만 값이 차고 1·3열은 빈 채로 남아야 한다.
const CODEX_ONLY_WEEKLY = (): UsageSummaryQuota[] => [
  quota("codex:weekly", "7일", "168h", 48, resetWeek),
];

const ANTIGRAVITY_QUOTAS = (): UsageSummaryQuota[] => [
  quota("antigravity:short", "5시간", "5h", 81, resetSoon),
  quota("antigravity:weekly", "7일", "7d", 56, resetWeek),
];

function summaryNode(state: ProviderPanelReviewState): UsageSummaryNode {
  const nodeId = NODE_BY_STATE[state];
  const poolList = sampleAccounts();
  const claude: UsageSummaryProvider = state === "pool"
    ? providerOf(CLAUDE_QUOTAS(), {
      mode: "pool",
      accounts: poolList.accounts,
      pool: poolList.pool,
      fable_pool: poolList.fable_pool,
      weeklyRemainingPercent: 66,
      weeklyResetAt: resetWeek,
      shortRemainingPercent: 62,
      shortResetAt: resetSoon,
    })
    : providerOf(CLAUDE_QUOTAS(), {
      mode: "legacy",
      weeklyRemainingPercent: 66,
      weeklyResetAt: resetWeek,
      shortRemainingPercent: 62,
      shortResetAt: resetSoon,
    });

  const opencodeGo = state === "legacy"
    ? providerOf([], { status: "not_configured" })
    : providerOf(OPENCODE_QUOTAS());

  const codex = state === "pool"
    ? providerOf(CODEX_ONLY_WEEKLY())
    : state === "legacy"
      ? null
      : providerOf([
        quota("codex:5h", "5시간", "5h", 90, resetSoon),
        quota("codex:weekly", "7일", "168h", 80, resetWeek),
      ]);

  const antigravity = state === "pool"
    ? providerOf(ANTIGRAVITY_QUOTAS())
    : state === "legacy"
      ? providerOf([], { status: "error" })
      : null;

  return {
    nodeId,
    fetchedAt: isoIn(nowSeconds - 4 * 60),
    stale: state === "legacy",
    staleSince: state === "legacy" ? "2026-11-07T15:20:00+09:00" : null,
    providers: {
      claude,
      opencode_go: opencodeGo,
      codex,
      antigravity,
    },
  };
}

function summarySnapshot(state: ProviderPanelReviewState): UsageSummarySnapshot {
  return {
    generatedAt: isoIn(nowSeconds),
    collectedAt: isoIn(nowSeconds - 4 * 60),
    nodes: [summaryNode(state)],
  };
}

function jsonData(data: unknown): Response {
  return Response.json(data);
}

export type ReviewCogitoState = "normal" | "loading" | "failure";

export function createProviderPanelReviewRequest(
  state: ProviderPanelReviewState,
  { summaryDelayMs = 0, cogitoState = "normal" }: { summaryDelayMs?: number; cogitoState?: ReviewCogitoState } = {},
): typeof fetch {
  const nodeId = NODE_BY_STATE[state];
  const basePath = `/api/nodes/${nodeId}/claude-auth`;
  let list = state === "pool" ? sampleAccounts() : LEGACY_ACCOUNTS;
  let snapshot = summarySnapshot(state);
  let flow: ClaudeAuthLoginFlow | null = null;
  let hasToken = true;

  return async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";

    if (path === "/api/usage/summary" && method === "GET") {
      if (summaryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, summaryDelayMs));
      return jsonData(snapshot);
    }
    if (path === "/api/usage/refresh" && method === "POST") {
      const refreshed = summarySnapshot(state);
      const node = refreshed.nodes[0]!;
      const claude = node.providers.claude;
      snapshot = {
        ...refreshed,
        nodes: [{
          ...node,
          fetchedAt: new Date().toISOString(),
          stale: false,
          staleSince: null,
          providers: {
            ...node.providers,
            claude: claude === null ? null : {
              ...claude,
              quotas: claude.quotas.map((item) => ({
                ...item,
                remainingPercent: item.remainingPercent === null ? null : Math.max(0, item.remainingPercent - 3),
              })),
            },
          },
        }],
      };
      return jsonData(snapshot);
    }
    if (path === "/cogito/briefs") {
      if (cogitoState === "loading") {
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
        });
      }
      if (cogitoState === "failure") {
        return Response.json({ error: "sample cogito unavailable" }, { status: 503 });
      }
      return jsonData(sampleCogitoBriefs([{ nodeId }]));
    }

    if (path === `${basePath}/accounts` && method === "GET") return jsonData(list);
    if (path === `${basePath}/status` && method === "GET") return jsonData({ has_token: hasToken });
    if (path === `${basePath}/profile` && method === "GET") {
      return jsonData({ account: { email: "sample@example.invalid", display_name: "검수 계정", has_claude_max: true } });
    }
    if (path === `${basePath}/headless/start` && method === "GET") return jsonData({ auth_url: "/dialogues#sample-auth" });
    if (path === `${basePath}/headless/submit-code` && method === "POST") return jsonData({ ok: true });
    if (path === `${basePath}/token` && method === "DELETE") {
      hasToken = false;
      return jsonData({ ok: true });
    }
    if (path === `${basePath}/logins` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { account_id?: string };
      flow = {
        login_id: "sample-login",
        account_id: body.account_id ?? null,
        state: "url_ready",
        auth_url: "https://example.invalid/claude-auth",
        expires_at: isoIn(nowSeconds + HOUR),
        error: null,
      };
      return jsonData(flow);
    }
    if (path === `${basePath}/logins/sample-login` && method === "GET") return jsonData(flow);
    if (path === `${basePath}/logins/sample-login/code` && method === "POST") {
      flow = { ...flow!, state: "done" };
      if (!flow.account_id) {
        list = {
          ...list,
          accounts: [...list.accounts, {
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
          }],
        };
      }
      return jsonData(flow);
    }
    if (path === `${basePath}/logins/sample-login` && method === "DELETE") {
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

function sampleNode(nodeId: string): OrchestratorNode {
  return {
    nodeId,
    host: "sample.invalid",
    port: 0,
    status: "connected",
    capabilities: {},
    connectedAt: 0,
    sessionCount: 2,
  };
}

// cogito 로딩·실패는 컴포넌트 검수 창 주소의 cogitoState로 연다(ComponentsReviewPage는 이 값을 넘기지 않는다).
function reviewCogitoState(): ReviewCogitoState {
  const value = new URLSearchParams(window.location.search).get("cogitoState");
  return value === "loading" || value === "failure" ? value : "normal";
}

export function ProviderPanelReviewSample({ state, loading = false }: { state: ProviderPanelReviewState; loading?: boolean }) {
  const nodeId = NODE_BY_STATE[state];
  // 스크린샷 한 장에 수 초가 걸리므로 로딩 상태 캡처가 스켈레톤을 담도록 넉넉히 늦춘다.
  const request = useMemo(
    () => createProviderPanelReviewRequest(state, {
      summaryDelayMs: loading ? 12_000 : 0,
      cogitoState: reviewCogitoState(),
    }),
    [state, loading],
  );
  const nodes = useMemo(() => new Map([[nodeId, sampleNode(nodeId)]]), [nodeId]);
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);

  return <QueryClientProvider client={client}>
    <NodePanel request={request} sampleNodes={nodes} />
  </QueryClientProvider>;
}

const REVIEW_STATES: Array<{ state: ProviderPanelReviewState; title: string }> = [
  { state: "pool", title: "Claude 계정 풀 · 기본 접힘 · 계정 펼치기" },
  { state: "legacy", title: "레거시 Claude · 미설정 · 조회 오류 · 수집 지연" },
  { state: "codex", title: "Codex 5시간·7일 두 칸" },
];

export function ClaudeAccountPoolReviewSample({ state, loading = false }: { state?: ProviderPanelReviewState | null; loading?: boolean } = {}) {
  const states = state ? REVIEW_STATES.filter((entry) => entry.state === state) : REVIEW_STATES;
  return <div className="space-y-3" data-testid="claude-account-review-sample">
    {states.map((entry) => <div key={entry.state} data-review-state={entry.state}>
      <p className="v3-components-label">{entry.title}</p>
      <ProviderPanelReviewSample state={entry.state} loading={loading} />
    </div>)}
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
    nodeId: "eiaserinnys",
    fetchedAt: "2026-10-28T09:11:00+09:00",
    stale: false,
    staleSince: null,
    providers: { claude, codex: null, antigravity: null, opencode_go: null },
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
