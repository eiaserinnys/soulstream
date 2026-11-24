import { useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UsageSummaryNode, UsageSummaryProvider } from "@seosoyoung/soul-ui";
import { CodingAgentsTab } from "../components/CodingAgentsTab";
import { NodeProvidersPanel } from "../components/NodeProvidersPanel";
import { PersistentSessionsTab } from "../components/PersistentSessionsTab";
import { AgentLoginSheet } from "../components/claude-accounts/AgentLoginSheet";
import type { AgentLoginFlow, AgentLoginProvider } from "../lib/agent-login-api";
import type { PersistentCreateDefaults } from "../lib/persistent-sessions";
import type { OrchestratorNode } from "../store/orchestrator-store";
import {
  dialoguesAssignment,
  dialoguesFolders,
  persistentSettingsModelPresets,
  persistentSettingsStory,
  persistentSettingsTimeline,
  usageFixtureProvider,
  usageFixtureQuota,
} from "./dialogues-api";
import { createPersistentSessionsFixture } from "./persistent-sessions-fixture";
import { PersistentSessionEmptyState } from "./PersistentSessionEmptyState";
import { V3GlobalToolbar } from "./V3GlobalToolbar";
import "./persistent-session-screen.css";

const ATOM_URL = "https://atom.example.invalid";
const noop = () => undefined;
const frame = (children: React.ReactNode, testId: string) => <div className="rounded-floor border border-border p-3" data-testid={testId}>{children}</div>;

/** 툴바 두 변형 × atom 있음과 없음. 왼쪽 위 기준으로 가두어 한 화면에 나란히 둔다. */
export function SettingsToolbarReviewSamples() {
  const cell = (label: string, children: React.ReactNode) => <div data-review-scene={label}>
    <p className="v3-components-label">{label}</p>
    <div className="persistent-session-screen" style={{ position: "relative", height: 96, minHeight: 0, transform: "translateZ(0)", overflow: "hidden" }}>{children}</div>
  </div>;
  return <div className="space-y-3" data-testid="settings-toolbar-review">
    {cell("PAS 창 툴바(minimal) · atom 있음", <V3GlobalToolbar variant="minimal" appearance="bare" agentName="서소영 (PAS)" atomUrl={ATOM_URL} onOpenConfig={noop} onOpenHome={noop}/>)}
    {cell("PAS 창 툴바(minimal) · atom 없음", <V3GlobalToolbar variant="minimal" appearance="bare" agentName="서소영 (PAS)" atomUrl={null} onOpenConfig={noop} onOpenHome={noop}/>)}
    {cell("기존 대시보드 툴바(default) · atom 있음", <V3GlobalToolbar atomUrl={ATOM_URL} onOpenConfig={noop} onOpenSearch={noop}/>)}
    {cell("기존 대시보드 툴바(default) · atom 없음", <V3GlobalToolbar atomUrl={null} onOpenConfig={noop} onOpenSearch={noop}/>)}
  </div>;
}

const DAY = 24 * 60 * 60;
const nowSeconds = Math.floor(Date.now() / 1000);
const quotas = () => [usageFixtureQuota("codex:weekly", "7일", "168h", 64, nowSeconds + 3 * DAY)];
const agentNode = (nodeId: string, providers: { codex: UsageSummaryProvider; antigravity: UsageSummaryProvider }): UsageSummaryNode => ({
  nodeId, fetchedAt: new Date().toISOString(), stale: false, staleSince: null,
  providers: { claude: null, opencode_go: null, ...providers },
});
const claudeLegacyRequest: typeof fetch = async (input) => {
  const path = String(input);
  if (path.endsWith("/claude-auth/accounts")) return Response.json({ mode: "legacy", accounts: [], pool: null, fable_pool: null });
  if (path.endsWith("/claude-auth/profile")) return Response.json({ account: { email: "sample@example.invalid", display_name: "검수 계정", has_claude_max: true } });
  return Response.json({ has_token: true });
};

/** 코딩 에이전트 행: 연결 안 됨(단추), 연결됨(다시 연결), 단추 없음(login_supported false). */
export function CodingAgentRowReviewSamples() {
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  const scenes: Array<{ label: string; node: UsageSummaryNode }> = [
    { label: "연결 안 됨 · 연결 단추", node: agentNode("sample-node-a", {
      codex: usageFixtureProvider([], { status: "not_configured", login_supported: true }),
      antigravity: usageFixtureProvider([], { status: "not_configured", login_supported: true }),
    }) },
    { label: "연결됨 · 다시 연결 단추", node: agentNode("sample-node-b", {
      codex: usageFixtureProvider(quotas(), { login_supported: true }),
      antigravity: usageFixtureProvider([usageFixtureQuota("antigravity:weekly", "7일", "7d", 56, nowSeconds + 4 * DAY)], { login_supported: true }),
    }) },
    { label: "단추 없음 · login_supported false", node: agentNode("sample-node-c", {
      codex: usageFixtureProvider([], { status: "not_configured", login_supported: false }),
      antigravity: usageFixtureProvider(quotas(), { login_supported: false }),
    }) },
  ];
  return <QueryClientProvider client={client}><div className="space-y-3" data-testid="coding-agent-rows-review">
    {scenes.map(({ label, node }) => <div key={label} data-review-scene={label}>
      <p className="v3-components-label">{label}</p>
      <NodeProvidersPanel nodeId={node.nodeId} request={claudeLegacyRequest} node={node} loading={false} />
    </div>)}
  </div></QueryClientProvider>;
}

const flowOf = (provider: AgentLoginProvider, state: AgentLoginFlow["state"], patch: Partial<AgentLoginFlow> = {}): AgentLoginFlow => ({
  login_id: "sample-agent-login", provider, state, auth_url: null, user_code: null, expects_code: provider === "antigravity", expires_at: null, error: null, ...patch,
});
/** 시작과 읽기가 같은 흐름을 돌려주고 취소만 받아 주는 가짜 서버. 코드와 주소는 모두 가짜 값이다. */
const sheetRequest = (flow: AgentLoginFlow): typeof fetch => async (_input, init) => {
  const method = init?.method ?? "GET";
  if (method === "DELETE") return Response.json({ ...flow, state: "cancelled" });
  return Response.json(flow);
};

export const AGENT_LOGIN_REVIEW_SCENES = [
  { id: "codex-url-ready", label: "Codex · 주소와 코드", provider: "codex" as const, flow: () => flowOf("codex", "url_ready", { auth_url: "https://auth.example.invalid/codex/device", user_code: "WXYZ-1234", expires_at: new Date(Date.now() + 14 * 60_000).toISOString() }) },
  { id: "antigravity-url-ready", label: "Antigravity · 주소와 코드 입력칸", provider: "antigravity" as const, flow: () => flowOf("antigravity", "url_ready", { auth_url: "https://auth.example.invalid/antigravity/oauth" }) },
  { id: "verifying", label: "확인 중", provider: "codex" as const, flow: () => flowOf("codex", "verifying") },
  { id: "done", label: "연결되었습니다", provider: "codex" as const, flow: () => flowOf("codex", "done") },
  { id: "failed-device-code", label: "실패 · device_code_disabled", provider: "codex" as const, flow: () => flowOf("codex", "failed", { error: { code: "device_code_disabled", message: "device code disabled" } }) },
  { id: "failed-invalid-code", label: "실패 · invalid_code", provider: "antigravity" as const, flow: () => flowOf("antigravity", "failed", { error: { code: "invalid_code", message: "invalid code" } }) },
];

export function AgentLoginSheetReviewSamples() {
  return <div className="space-y-3" data-testid="agent-login-sheet-review">
    {AGENT_LOGIN_REVIEW_SCENES.map((scene) => <div key={scene.id} data-review-scene={scene.id}>
      <p className="v3-components-label">{scene.label}</p>
      <AgentLoginSheet nodeId="sample-node-a" provider={scene.provider} request={sheetRequest(scene.flow())} onClose={noop} onDone={noop} />
    </div>)}
  </div>;
}

const emptyDefaults = (patch: Partial<PersistentCreateDefaults>): PersistentCreateDefaults => ({
  node_id: "sample-node", preferred_agent_id: "roselin", initial_instruction: "", unavailable_reason: null,
  settings: { default_model: { model_preset: null, reasoning_effort: null }, fallback_models: [], show_generation_separator: true, show_character: true, show_jev_candidates: true, animate_character: true, turn_usage_mode: "collapsed", show_turn_usage: true },
  ...patch,
});

export function PersistentEmptyStateReviewSamples() {
  const pending = { bootstrap: () => new Promise<{ created: boolean; session_id: string }>(() => undefined) };
  const failing = { bootstrap: async (): Promise<{ created: boolean; session_id: string }> => { throw new Error("서버가 응답하지 않았습니다 (503)."); } };
  const scenes = [
    { id: "manual", label: "bootstrap 꺼짐 · 영구 세션 만들기", api: pending, defaults: emptyDefaults({}), admin: true },
    { id: "unavailable-admin", label: "연결 필요 · 관리자", api: pending, defaults: emptyDefaults({ bootstrap_enabled: true, unavailable_reason: "쓸 수 있는 모델이 없습니다. 코딩 에이전트를 먼저 연결해 주십시오." }), admin: true },
    { id: "unavailable-user", label: "연결 필요 · 관리자가 아님", api: pending, defaults: emptyDefaults({ bootstrap_enabled: true, unavailable_reason: "쓸 수 있는 모델이 없습니다. 코딩 에이전트를 먼저 연결해 주십시오." }), admin: false },
    { id: "creating", label: "기본 영구 세션을 만드는 중", api: pending, defaults: emptyDefaults({ bootstrap_enabled: true }), admin: true },
    { id: "failed", label: "만들기 실패 · 다시 시도", api: failing, defaults: emptyDefaults({ bootstrap_enabled: true }), admin: true },
  ];
  return <div className="space-y-3" data-testid="persistent-empty-review">
    {scenes.map((scene) => <div key={scene.id} data-review-scene={scene.id}>
      <p className="v3-components-label">{scene.label}</p>
      <div className="persistent-session-screen" style={{ position: "relative", height: 200, minHeight: 0, overflow: "hidden" }}>
        <PersistentSessionEmptyState api={scene.api} defaults={scene.defaults} isAdmin={scene.admin} onOpenCodingAgents={noop} onCreate={noop} />
      </div>
    </div>)}
  </div>;
}

/** 설정창의 영구 세션 탭 상세. 다섯 절이 모두 그려진다. 저장은 이 가짜 전송 안에서만 일어난다. */
export function PersistentSessionsTabReviewSample() {
  const [request] = useState<typeof fetch>(() => {
    const fixture = createPersistentSessionsFixture({ scenario: "normal", nodeId: "sample-node", folderId: dialoguesFolders[0]!.id });
    const handler: typeof fetch = async (input, init) => {
      const url = new URL(String(input), "https://sample.invalid");
      const path = url.pathname;
      if (path.startsWith("/api/persistent-sessions")) return fixture(input, init);
      if (/^\/api\/sessions\/[^/]+\/story$/.test(path)) return Response.json(persistentSettingsStory);
      if (/^\/api\/sessions\/[^/]+\/timeline$/.test(path)) {
        const types = url.searchParams.get("event_types")?.split(",");
        const messages = types ? persistentSettingsTimeline.filter((message) => types.includes(message.event_type)) : persistentSettingsTimeline;
        return Response.json({ messages: messages.slice(0, Number(url.searchParams.get("limit") ?? messages.length)), next_cursor: null });
      }
      if (/^\/api\/nodes\/[^/]+\/model-presets$/.test(path)) return Response.json({ model_presets: persistentSettingsModelPresets });
      return Response.json({ error: "sample route missing" }, { status: 404 });
    };
    return handler;
  });
  return frame(<PersistentSessionsTab request={request} assignment={dialoguesAssignment} initialPersistentSessionId="sample-pas-1" />, "persistent-sessions-tab-review");
}

/** 코딩 에이전트 탭 전체(노드 목록과 공급자 행). 가짜 노드 하나와 가짜 사용량 요약이다. */
export function CodingAgentsTabReviewSample() {
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  const node: OrchestratorNode = { nodeId: "sample-node-a", host: "sample.invalid", port: 0, status: "connected", capabilities: {}, connectedAt: 0, sessionCount: 1 };
  const request = useMemo<typeof fetch>(() => async (input, init) => {
    const path = String(input);
    if (path === "/api/usage/summary") {
      return Response.json({
        generatedAt: new Date().toISOString(), collectedAt: null,
        nodes: [agentNode("sample-node-a", { codex: usageFixtureProvider([], { status: "not_configured", login_supported: true }), antigravity: usageFixtureProvider(quotas(), { login_supported: true }) })],
      });
    }
    return claudeLegacyRequest(input, init);
  }, []);
  return <QueryClientProvider client={client}>{frame(<CodingAgentsTab request={request} sampleNodes={new Map([[node.nodeId, node]])} />, "coding-agents-tab-review")}</QueryClientProvider>;
}
