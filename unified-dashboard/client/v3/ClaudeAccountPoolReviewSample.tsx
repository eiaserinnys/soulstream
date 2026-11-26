import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ClaudeAccount,
  ClaudeAccountList,
  ClaudeAuthLoginFlow,
} from "../../../packages/wire-schema/generated/typescript/index";
import type {
  ClaudeCentralSettings,
  UsageSummaryGauge,
  UsageSummaryNode,
  UsageSummaryProvider,
  UsageSummaryQuota,
  UsageSummarySnapshot,
} from "@seosoyoung/soul-ui";
import { NodePanel } from "../components/NodePanel";
import { sampleCogitoBriefs } from "../components/CogitoNodeHealthSample";
import { usageFixtureProvider, usageFixtureQuota } from "./dialogues-api";
import type { OrchestratorNode } from "../store/orchestrator-store";
import { PersistentSessionWeeklyUsage } from "./PersistentSessionWeeklyUsage";

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const nowSeconds = Math.floor(Date.now() / 1000);
const resetSoon = nowSeconds + 3 * HOUR;
const resetWeek = nowSeconds + 5 * DAY;
const resetMonth = nowSeconds + 11 * DAY;
// 카드 #1510 검수 상태: 지난 50%, 지난 60%.
const resetHalf = nowSeconds + Math.round(3.5 * DAY);
const resetSixty = nowSeconds + Math.round(2.8 * DAY);

function isoIn(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function sampleAccounts(): ClaudeAccountList {
  const accounts: ClaudeAccount[] = [
    {
      id: "sample-main",
      email: "director@example.com",
      plan: "Max 20x",
      enabled: true,
      priority: 1,
      auth_state: "ok",
      source: "local",
      usage: {
        five_hour: { used_percent: 24, resets_at: isoIn(resetSoon) },
        seven_day: { used_percent: 72, resets_at: isoIn(resetHalf) },
        fable_weekly: { used_percent: 20, resets_at: isoIn(resetSixty) },
      },
      observed_at: isoIn(nowSeconds - 6 * HOUR),
      blocked: null,
      active_sessions: 2,
    },
    {
      id: "sample-secondary",
      email: "director.sub@example.com",
      plan: "Max 5x",
      enabled: true,
      priority: 2,
      auth_state: "ok",
      source: "local",
      usage: {
        five_hour: { used_percent: 100, resets_at: isoIn(resetSoon) },
        seven_day: { used_percent: 48, resets_at: isoIn(resetHalf) },
        fable_weekly: { used_percent: 46, resets_at: null },
      },
      observed_at: isoIn(nowSeconds - 8 * HOUR),
      blocked: { until: isoIn(resetSoon), scope: "all" },
      active_sessions: 0,
    },
    {
      id: "sample-backup",
      email: "director.backup@example.com",
      plan: "Pro",
      enabled: true,
      priority: 3,
      auth_state: "idle",
      source: "local",
      usage: { five_hour: null, seven_day: null, fable_weekly: null },
      observed_at: isoIn(nowSeconds - 26 * HOUR),
      blocked: null,
      active_sessions: 0,
    },
    {
      id: "sample-logging-in",
      email: "director.login@example.com",
      plan: "Max 5x",
      enabled: true,
      priority: 4,
      auth_state: "logging_in",
      source: "local",
      login_expires_at: new Date(Date.now() + 8 * 60_000).toISOString(),
      usage: { five_hour: null, seven_day: null, fable_weekly: null },
      observed_at: isoIn(nowSeconds - 2 * HOUR),
      blocked: null,
      active_sessions: 0,
    },
  ];
  return {
    mode: "pool",
    accounts,
    pool: {
      available_count: 2,
      total_count: 4,
      best_weekly_remaining_percent: 87,
      best_weekly_resets_at: isoIn(resetWeek),
      earliest_available_at: isoIn(resetSoon),
    },
    fable_pool: {
      available_count: 2,
      total_count: 4,
      best_weekly_remaining_percent: 82,
      best_weekly_resets_at: isoIn(resetWeek),
      earliest_available_at: isoIn(resetSoon),
    },
  };
}

const LEGACY_ACCOUNTS: ClaudeAccountList = { mode: "legacy", accounts: [], pool: null, fable_pool: null };

const EMPTY_POOL = { available_count: 0, total_count: 0, best_weekly_remaining_percent: null, best_weekly_resets_at: null, earliest_available_at: null };
const EMPTY_POOL_ACCOUNTS: ClaudeAccountList = { mode: "pool", accounts: [], pool: EMPTY_POOL, fable_pool: EMPTY_POOL };

export type ProviderPanelReviewState = "pool" | "legacy" | "codex" | "none";

const NODE_BY_STATE: Record<ProviderPanelReviewState, string> = {
  pool: "sample-provider-pool",
  legacy: "sample-provider-legacy",
  codex: "sample-provider-codex",
  none: "sample-provider-none",
};

const CLAUDE_QUOTAS = (): UsageSummaryQuota[] => [
  usageFixtureQuota("claude:5h", "5시간", "5h", 62, resetSoon),
  usageFixtureQuota("claude:weekly", "7일", "7d", 66, resetWeek),
  usageFixtureQuota("claude:weekly_scoped:fable", "Fable", "7d", 88, resetWeek),
];

const OPENCODE_QUOTAS = (): UsageSummaryQuota[] => [
  usageFixtureQuota("opencode:short", "5시간", "5h", 75, resetSoon),
  usageFixtureQuota("opencode:weekly", "7일", "168h", 39, resetWeek),
  usageFixtureQuota("opencode:monthly", "월간", "monthly", 52, resetMonth),
];

const CODEX_ONLY_WEEKLY = (): UsageSummaryQuota[] => [
  usageFixtureQuota("codex:weekly", "7일", "168h", 48, resetWeek),
];

const ANTIGRAVITY_QUOTAS = (): UsageSummaryQuota[] => [
  usageFixtureQuota("antigravity:short", "5시간", "5h", 81, resetSoon),
  usageFixtureQuota("antigravity:weekly", "7일", "7d", 56, resetWeek),
];

function summaryNode(state: ProviderPanelReviewState): UsageSummaryNode {
  const nodeId = NODE_BY_STATE[state];
  const poolList = sampleAccounts();
  const claude: UsageSummaryProvider = state === "none"
    ? usageFixtureProvider([], { status: "not_configured", mode: "pool", accounts: [], pool: EMPTY_POOL, fable_pool: EMPTY_POOL })
    : state === "pool"
    ? usageFixtureProvider(CLAUDE_QUOTAS(), {
      mode: "pool",
      accounts: poolList.accounts,
      pool: poolList.pool,
      fable_pool: poolList.fable_pool,
      weeklyRemainingPercent: 66,
      weeklyResetAt: resetWeek,
      shortRemainingPercent: 62,
      shortResetAt: resetSoon,
    })
    : usageFixtureProvider(CLAUDE_QUOTAS(), {
      mode: "legacy",
      weeklyRemainingPercent: 66,
      weeklyResetAt: resetWeek,
      shortRemainingPercent: 62,
      shortResetAt: resetSoon,
    });

  const opencodeGo = state === "none"
    ? null
    : state === "legacy"
      ? usageFixtureProvider([], { status: "not_configured" })
      : usageFixtureProvider(OPENCODE_QUOTAS());

  const codex = state === "none"
    ? usageFixtureProvider([], { status: "not_configured", login_supported: true })
    : state === "pool"
    ? usageFixtureProvider(CODEX_ONLY_WEEKLY())
    : state === "legacy"
      ? null
      : usageFixtureProvider([
        usageFixtureQuota("codex:5h", "5시간", "5h", 90, resetSoon),
        usageFixtureQuota("codex:weekly", "7일", "168h", 80, resetWeek),
      ]);

  const antigravity = state === "none"
    ? usageFixtureProvider([], { status: "not_configured", login_supported: true })
    : state === "pool"
    ? usageFixtureProvider(ANTIGRAVITY_QUOTAS())
    : state === "legacy"
      ? usageFixtureProvider([], { status: "error" })
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
  let list = state === "pool" ? sampleAccounts() : state === "none" ? EMPTY_POOL_ACCOUNTS : LEGACY_ACCOUNTS;
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
            source: "local",
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
      // 계정 행 오류 줄(actionError)을 실제 경로로 띄우는 검수 상태. 주소의 claudeActionState=failure로 연다.
      if (new URLSearchParams(window.location.search).get("claudeActionState") === "failure") {
        return Response.json({ code: "sample_failure", message: "sample claude action failed" }, { status: 503 });
      }
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

export const CENTRAL_REVIEW_SCENES = [
  "empty",
  "accounts",
  "login-url-ready",
  "login-verifying",
  "login-failed",
  "loading",
  "failure",
  "receive-off",
  "receive-pending",
  "receive-failure",
  "receive-settings-error",
] as const;

export type CentralReviewScene = (typeof CENTRAL_REVIEW_SCENES)[number];

export function isCentralReviewScene(value: string | null): value is CentralReviewScene {
  return value !== null && (CENTRAL_REVIEW_SCENES as readonly string[]).includes(value);
}

const CENTRAL_NODE_ID = "sample-central-node";

function centralAccountList(): ClaudeAccountList {
  const accounts: ClaudeAccount[] = [
    {
      id: "8f42c1a6-4b1e-4f5a-9ad3-0d6b1f5c2e71",
      email: "eiaserinnys.central.primary@example.invalid",
      plan: "Max 20x",
      enabled: true,
      priority: 1,
      auth_state: "ok",
      source: "local",
      usage: {
        five_hour: { used_percent: 18, resets_at: isoIn(resetSoon) },
        seven_day: { used_percent: 64, resets_at: isoIn(resetHalf) },
        fable_weekly: { used_percent: 22, resets_at: isoIn(resetSixty) },
      },
      observed_at: isoIn(nowSeconds - 5 * 60),
      blocked: null,
      active_sessions: 0,
    },
    {
      id: "2d7a90fe-6c3b-4a18-b2f4-9e8d7c650a13",
      email: "eiaserinnys.central.backup@example.invalid",
      plan: "Max 5x",
      enabled: true,
      priority: 2,
      auth_state: "needs_relogin",
      source: "local",
      usage: { five_hour: null, seven_day: null, fable_weekly: null },
      observed_at: isoIn(nowSeconds - 3 * DAY),
      blocked: null,
      active_sessions: 0,
    },
    {
      id: "c56e18b9-3f04-4d72-a0c8-51b9e2f74d68",
      email: "eiaserinnys.central.archive.long.address@example.invalid",
      plan: "Pro",
      enabled: false,
      priority: 3,
      auth_state: "ok",
      source: "local",
      usage: {
        five_hour: { used_percent: 9, resets_at: isoIn(resetSoon) },
        seven_day: { used_percent: 31, resets_at: isoIn(resetWeek) },
        fable_weekly: null,
      },
      observed_at: isoIn(nowSeconds - 26 * HOUR),
      blocked: null,
      active_sessions: 0,
    },
  ];
  return {
    mode: "pool",
    accounts,
    pool: {
      available_count: 1,
      total_count: 3,
      best_weekly_remaining_percent: 69,
      best_weekly_resets_at: isoIn(resetHalf),
      earliest_available_at: null,
    },
    fable_pool: {
      available_count: 1,
      total_count: 3,
      best_weekly_remaining_percent: 78,
      best_weekly_resets_at: isoIn(resetHalf),
      earliest_available_at: null,
    },
  };
}

function centralNodeAccounts(scene: CentralReviewScene): ClaudeAccountList {
  const localAccounts: ClaudeAccount[] = scene === "receive-off" || scene === "receive-pending" || scene === "receive-failure" || scene === "receive-settings-error"
    ? [
      {
        id: "local-4f1e2d3c",
        email: "node-local.primary@example.invalid",
        plan: "Max 5x",
        enabled: true,
        priority: 1,
        auth_state: "ok",
        source: "local",
        usage: {
          five_hour: { used_percent: 42, resets_at: isoIn(resetSoon) },
          seven_day: { used_percent: 36, resets_at: isoIn(resetWeek) },
          fable_weekly: null,
        },
        observed_at: isoIn(nowSeconds - 12 * 60),
        blocked: null,
        active_sessions: 1,
      },
      {
        id: "local-9a8b7c6d",
        email: "node-local.second@example.invalid",
        plan: "Pro",
        enabled: true,
        priority: 2,
        auth_state: "idle",
        source: "local",
        usage: { five_hour: null, seven_day: null, fable_weekly: null },
        observed_at: isoIn(nowSeconds - 2 * DAY),
        blocked: null,
        active_sessions: 0,
      },
    ]
    : [];
  const centralAccounts = scene === "empty"
    ? []
    : centralAccountList().accounts.map((account) => ({ ...account, source: "central" as const }));
  const total = localAccounts.length + centralAccounts.length;
  return {
    mode: "pool",
    accounts: [...localAccounts, ...centralAccounts],
    pool: {
      available_count: Math.min(total, localAccounts.length + 1),
      total_count: total,
      best_weekly_remaining_percent: total === 0 ? null : 69,
      best_weekly_resets_at: total === 0 ? null : isoIn(resetHalf),
      earliest_available_at: null,
    },
    fable_pool: null,
  };
}

function centralSettings(scene: CentralReviewScene): ClaudeCentralSettings {
  const receive = scene !== "receive-off";
  return {
    default_receive: true,
    nodes: { [CENTRAL_NODE_ID]: receive },
    effective: [{ node_id: CENTRAL_NODE_ID, receive, connected: true }],
  };
}

function centralSummary(): UsageSummarySnapshot {
  const snapshot = summarySnapshot("pool");
  return { ...snapshot, nodes: [{ ...snapshot.nodes[0]!, nodeId: CENTRAL_NODE_ID }] };
}

function neverResponse(init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  return new Promise<Response>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
  });
}

/** 중앙 풀 카드와 노드 받기 스위치의 검수 상태를 만든다. 실제 API는 부르지 않는다. */
export function createCentralReviewRequest(scene: CentralReviewScene): typeof fetch {
  let settings = centralSettings(scene);
  let centralList = scene === "empty"
    ? { ...centralAccountList(), accounts: [], pool: { ...centralAccountList().pool!, available_count: 0, total_count: 0 } }
    : centralAccountList();
  let nodeList = centralNodeAccounts(scene);
  let flow: ClaudeAuthLoginFlow | null = null;

  return async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";

    if (path === "/api/usage/summary" && method === "GET") return jsonData(centralSummary());
    if (path === "/cogito/briefs") return jsonData(sampleCogitoBriefs([{ nodeId: CENTRAL_NODE_ID }]));
    if (path === `/api/nodes/${CENTRAL_NODE_ID}/claude-auth/accounts` && method === "GET") return jsonData(nodeList);
    if (path === "/api/claude-auth/central/accounts" && method === "GET") {
      if (scene === "loading") return neverResponse(init);
      if (scene === "failure") {
        return Response.json({ code: "central_unavailable", message: "중앙 풀을 읽지 못했습니다." }, { status: 503 });
      }
      return jsonData(centralList);
    }
    if (path === "/api/claude-auth/central/settings" && method === "GET") {
      if (scene === "receive-settings-error") {
        return Response.json({ code: "settings_unavailable", message: "받기 설정을 읽지 못했습니다." }, { status: 503 });
      }
      return jsonData(settings);
    }
    if (path === "/api/claude-auth/central/settings" && method === "PUT") {
      if (scene === "receive-pending") return neverResponse(init);
      if (scene === "receive-failure") {
        return Response.json({ code: "settings_failed", message: "받기 설정을 저장하지 못했습니다." }, { status: 503 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { nodes?: Record<string, boolean> };
      const next = body.nodes ?? {};
      settings = {
        ...settings,
        nodes: { ...settings.nodes, ...next },
        effective: settings.effective.map((entry) => next[entry.node_id] === undefined
          ? entry
          : { ...entry, receive: next[entry.node_id]! }),
      };
      // 설정을 받은 노드는 그 자리에서 계정 목록이 달라진다.
      const receive = settings.effective.find((entry) => entry.node_id === CENTRAL_NODE_ID)?.receive ?? true;
      nodeList = receive ? centralNodeAccounts("accounts") : centralNodeAccounts("receive-off");
      return jsonData(settings);
    }
    if (path === "/api/claude-auth/central/logins" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { account_id?: string };
      flow = {
        login_id: "review-central-login",
        account_id: body.account_id ?? null,
        state: "url_ready",
        auth_url: "https://example.invalid/claude-central-auth",
        expires_at: isoIn(nowSeconds + HOUR),
        error: null,
      };
      return jsonData(flow);
    }
    if (path === "/api/claude-auth/central/logins/review-central-login" && method === "GET") {
      return jsonData(flow);
    }
    if (path === "/api/claude-auth/central/logins/review-central-login/code" && method === "POST") {
      flow = scene === "login-failed"
        ? { ...flow!, state: "failed", auth_url: null, error: { code: "invalid_login_code", message: "인증 코드가 만료되었거나 이미 사용되었습니다." } }
        : { ...flow!, state: "verifying", auth_url: null };
      return jsonData(flow);
    }
    if (path === "/api/claude-auth/central/logins/review-central-login" && method === "DELETE") {
      flow = { ...flow!, state: "cancelled", auth_url: null };
      return jsonData(flow);
    }
    const accountMatch = path.match(/^\/api\/claude-auth\/central\/accounts\/([^/]+)$/);
    if (accountMatch && method === "PATCH") {
      const accountId = decodeURIComponent(accountMatch[1]!);
      const body = JSON.parse(String(init?.body ?? "{}")) as { enabled?: boolean; priority?: number };
      centralList = {
        ...centralList,
        accounts: centralList.accounts.map((account) => account.id === accountId ? { ...account, ...body } : account),
      };
      return jsonData(centralList);
    }
    if (accountMatch && method === "DELETE") {
      const accountId = decodeURIComponent(accountMatch[1]!);
      centralList = { ...centralList, accounts: centralList.accounts.filter((account) => account.id !== accountId) };
      return jsonData({ success: true });
    }
    return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
  };
}

export function ClaudeCentralPoolReviewSample({ scene: initialScene }: { scene: CentralReviewScene }) {
  // 시각 검수 스크립트가 페이지를 다시 적재하지 않고 장면만 바꿀 수 있게 주소의 scene을 따라간다.
  const [scene, setScene] = useState<CentralReviewScene>(initialScene);
  useEffect(() => {
    const apply = () => {
      const next = new URLSearchParams(window.location.search).get("scene");
      if (isCentralReviewScene(next)) setScene(next);
    };
    window.addEventListener("popstate", apply);
    return () => window.removeEventListener("popstate", apply);
  }, []);
  const request = useMemo(() => createCentralReviewRequest(scene), [scene]);
  const nodes = useMemo(() => new Map([[CENTRAL_NODE_ID, sampleNode(CENTRAL_NODE_ID)]]), []);
  // 장면마다 질의 캐시와 펼침 상태를 새로 시작한다.
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), [scene]);
  return <QueryClientProvider key={scene} client={client}>
    <div className="p-2" data-scene={scene}><NodePanel request={request} sampleNodes={nodes} /></div>
  </QueryClientProvider>;
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
    {/* 검수 창에는 설정 구역 틀이 없으므로 안쪽 여백은 이 샘플 틀이 가진다. */}
    <div className="p-2"><NodePanel request={request} sampleNodes={nodes} /></div>
  </QueryClientProvider>;
}

const REVIEW_STATES: Array<{ state: ProviderPanelReviewState; title: string }> = [
  { state: "pool", title: "Claude 계정 풀 · 기본 접힘 · 계정 펼치기" },
  { state: "legacy", title: "레거시 Claude · 미설정 · 조회 오류 · 수집 지연" },
  { state: "codex", title: "Codex 5시간·7일 두 칸" },
  { state: "none", title: "Claude 계정 0개 · 미설정 · 연결 · Codex와 Antigravity 미설정 · 연결" },
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
