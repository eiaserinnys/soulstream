/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOrchestratorStore } from "../../store/orchestrator-store";
import { resetAtomPublicUrlForTests } from "../../../../packages/soul-ui/src/hooks/useAtomPublicUrl";
import { resetGuideSession, type CatalogGuide, type ContextOverview, type GuideFinding, type GuideReport, type SkillGuide } from "../../lib/skill-guides";
import { SkillCatalogTab } from "./SkillCatalogTab";

const finding = (level: GuideFinding["level"], code = "W103"): GuideFinding => ({ code, level, message: `${code} 진단 문구` });
const lint = (extra: Partial<NonNullable<SkillGuide["lint"]>> = {}): NonNullable<SkillGuide["lint"]> => ({
  body_chars: 100, links: [], called_by: [], block_counts: {}, agent_count: 1, findings: [], ...extra,
});
const skill = (name: string, lintValue: SkillGuide["lint"]): SkillGuide => ({
  name, description: `${name} 설명`, entry_node_id: `n-${name}`, entry_card_id: `c-${name}`, body_node_id: `b-${name}`, lint: lintValue,
});
const report = (extra: Partial<GuideReport> = {}): GuideReport => ({
  generated_at: "2026-11-25T05:30:00.000Z", uploaded_at: "2026-11-25T05:40:00.000Z", uploaded_by_session_id: null, verify_job_id: "job-1", findings: [], ...extra,
});

// 정렬 기대: error-skill(오류) → warn-skill(경고, 프로필 1) → busy-skill(진단 없음, 프로필 2) → idle-skill(진단 없음, 프로필 0) → 보고에 없는 스킬
const skills = [
  skill("idle-skill", lint()),
  skill("busy-skill", lint({ links: [{ kind: "call", target: "warn-skill", target_kind: "skill" }, { kind: null, target: "shared-catalog", target_kind: "catalog" }] })),
  skill("warn-skill", lint({ findings: [finding("warning")], called_by: ["busy-skill", "legacy-caller"] })),
  skill("error-skill", lint({ findings: [finding("error", "E007"), finding("warning")] })),
  skill("missing-skill", null),
];
const catalogs: CatalogGuide[] = [
  { name: "shared-catalog", description: "공유 갈래", node_id: "cn", card_id: "cc", lint: { axis: ["작업 종류"], composition: ["busy-skill (기본)"], used_by: ["busy-skill"], findings: [] } },
  { name: "unreported-catalog", description: "보고에 없는 갈래", node_id: "cn2", card_id: "cc2", lint: null },
];
const overview: ContextOverview = {
  node_id: "node-a", collected_at: null,
  profiles: [
    { agent_id: "p1", display_name: "프로필 하나", source: "db", status: "ok", error: null, sources: [{
      node_id: "s1", title: "skills", parent_title: "공통", origin: { kind: "bundle", bundle_id: "b", bundle_name: "공통 스킬" }, applies_when: { os: ["windows"] },
      mode: "full", depth: 2, chars: 10, token_estimate: 3, status: "ok",
      documents: [
        { node_id: "n-busy-skill", card_id: "c-busy-skill", title: "busy-skill", depth: 1, chars: 10 }, { node_id: "b-busy-skill", card_id: "x1", title: "본문", depth: 2, chars: 10 },
        { node_id: "n-warn-skill", card_id: "c-warn-skill", title: "warn-skill", depth: 1, chars: 10 },
      ],
    }] },
    { agent_id: "p2", display_name: "프로필 둘", source: "yaml", status: "ok", error: null, sources: [{
      node_id: "s2", title: "skills", parent_title: "아무개", origin: { kind: "node_config" }, applies_when: null,
      mode: "index", depth: 1, chars: 10, token_estimate: 3, status: "ok",
      documents: [{ node_id: "n-busy-skill", card_id: "c-busy-skill", title: "busy-skill", depth: 1, chars: 10 }],
    }] },
  ],
};

interface Setup { guides?: unknown; guidesStatus?: number; verify?: number; overviewStatus?: number; bodyStatus?: number }
function makeRequest(setup: Setup = {}) {
  const calls: string[] = [];
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/skill-guides/verify") return new Response(JSON.stringify({ job_id: "j" }), { status: setup.verify ?? 202 });
    if (url === "/api/skill-guides") return setup.guidesStatus ? new Response("{}", { status: setup.guidesStatus }) : Response.json(setup.guides ?? { skills, catalogs, report: report() });
    if (url.endsWith("/body")) return setup.bodyStatus ? new Response("{}", { status: setup.bodyStatus }) : Response.json({ name: "x", body_node_id: "b", markdown: "# 본문 제목\n\n본문 문장" });
    if (url.endsWith("/context-overview")) return setup.overviewStatus ? new Response("{}", { status: setup.overviewStatus }) : Response.json(overview);
    return new Response("{}", { status: 404 });
  });
  return { request: request as unknown as typeof fetch, calls, mock: request };
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0); else await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}
async function mount(request: typeof fetch) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(SkillCatalogTab, { request })); });
  await flush();
  await flush();
}
const rows = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>("button[data-settings-list-row]"));
const rowNames = () => rows().map(row => row.querySelector(".font-medium")!.textContent);
const button = (label: string | RegExp) => Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(item => typeof label === "string" ? item.textContent?.trim() === label : label.test(item.textContent ?? ""));
async function click(target: Element | undefined | null) { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click(); }); await flush(); }
const tab = (label: string) => Array.from(document.body.querySelectorAll<HTMLElement>('[role="tab"]')).find(item => item.textContent?.startsWith(label));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ atom_public_url: "https://atom.example.invalid" })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  resetAtomPublicUrlForTests();
  useOrchestratorStore.setState({ nodes: new Map([["node-a", { nodeId: "node-a", host: "h", port: 1, status: "connected", capabilities: {}, connectedAt: 1, sessionCount: 0 }]]) as never });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined; host = undefined;
  vi.useRealTimers(); vi.unstubAllGlobals(); resetGuideSession(); resetAtomPublicUrlForTests();
});

describe("SkillCatalogTab 목록", () => {
  it("진단이 무거운 것부터, 같은 무게 안에서는 프로필에 많이 쓰이는 것부터 놓는다", async () => {
    await mount(makeRequest().request);
    expect(rowNames()).toEqual(["error-skill", "warn-skill", "busy-skill", "idle-skill", "missing-skill"]);
    // 줄 바닥에는 상시 목록에 넣은 프로필 수를 적는다.
    expect(rows()[2]!.textContent).toContain("프로필 2");
    expect(rows()[3]!.textContent).toContain("프로필 0");
  });

  it("보고에 없는 스킬에는 「보고에 없음」 배지를 달고, 진단 배지는 가장 무거운 것 하나와 수만 보인다", async () => {
    await mount(makeRequest().request);
    expect(rows()[0]!.textContent).toContain("오류 1");
    expect(rows()[4]!.textContent).toContain("보고에 없음");
  });

  it("「경고 있는 것만」은 오류와 경고만 남긴다", async () => {
    await mount(makeRequest().request);
    await click(button("경고 있는 것만"));
    expect(rowNames()).toEqual(["error-skill", "warn-skill"]);
    expect(button("경고 있는 것만")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("카탈로그 상세의 「atom에서 열기」는 node_id가 있을 때만 보인다", async () => {
    const nullable = [...catalogs, { name: "no-id-catalog", description: "id 없는 갈래", node_id: null, card_id: null, lint: null }];
    await mount(makeRequest({ guides: { skills, catalogs: nullable, report: report() } }).request);
    await click(tab("카탈로그"));
    const openButton = () => document.body.querySelector('button[aria-label="atom에서 열기"]');
    await vi.waitFor(() => expect(rowNames()).toContain("no-id-catalog"));
    await click(rows()[0]);
    await vi.waitFor(() => expect(openButton()).not.toBeNull());
    await click(rows()[rowNames().indexOf("no-id-catalog")]);
    expect(openButton()).toBeNull();
  });

  it("카탈로그 탭은 쓰는 스킬 수로 차례를 잡고 상세에 축, 구성, 쓰는 스킬, 진단을 보인다", async () => {
    await mount(makeRequest().request);
    await click(tab("카탈로그"));
    expect(rowNames()).toEqual(["shared-catalog", "unreported-catalog"]);
    expect(document.body.textContent).toContain("작업 종류");
    expect(document.body.textContent).toContain("busy-skill (기본)");
    await click(rows()[1]);
    expect(document.body.textContent).toContain("보고에 없음");
  });

  it("목록 요청이 실패하면 그 자리가 실패 안내로 바뀌고 다시 시도하면 목록이 선다", async () => {
    const setup: Setup = { guidesStatus: 503 };
    const { request } = makeRequest(setup);
    await mount(request);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("불러오지 못했습니다");
    setup.guidesStatus = undefined;
    await click(button("다시 시도"));
    expect(rows().length).toBe(5);
  });

  it("목록이 비어 있으면 빈 상태 글이 선다", async () => {
    await mount(makeRequest({ guides: { skills: [], catalogs: [], report: report({ verify_job_id: null }) } }).request);
    // 안내는 목록 자리에만 한 번 선다. 상세 자리는 비어 있다.
    expect(document.body.textContent!.match(/항목이 없습니다\./g)).toHaveLength(1);
    expect(rows()).toHaveLength(0);
  });

  it("로딩 중에는 틀이 먼저 서고 목록 자리에 스켈레톤이 있다", async () => {
    const request = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    await mount(request);
    expect(document.body.querySelector('[data-testid="skill-catalog-skeleton"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="skill-catalog-frame"]')).not.toBeNull();
  });
});

describe("SkillCatalogTab 상세", () => {
  it("스킬 상세는 본문 / 연결 / 쓰이는 곳 / 검증 탭을 갖고 본문은 탭을 열 때 읽는다", async () => {
    const { request, calls } = makeRequest();
    await mount(request);
    await click(rows()[2]); // busy-skill
    expect(["본문", "연결", "쓰이는 곳", "검증"].map(label => Boolean(tab(label)))).toEqual([true, true, true, true]);
    await flush();
    // 처음 고른 스킬과 눌러 연 스킬의 본문만 읽는다. 목록의 다른 스킬 본문은 읽지 않는다.
    expect(calls.filter(call => call.endsWith("/body"))).toEqual(["GET /api/skill-guides/error-skill/body", "GET /api/skill-guides/busy-skill/body"]);
    expect(document.body.textContent).toContain("본문 문장");
  });

  it("연결 탭은 나가는 연결(종류 칩)과 들어오는 연결(called_by 포함)을 보이고, 종류가 null이면 칩이 없다", async () => {
    await mount(makeRequest().request);
    await click(rows()[1]); // warn-skill
    await click(tab("연결"));
    const incoming = document.body.textContent!;
    expect(incoming).toContain("나가는 연결");
    expect(incoming).toContain("busy-skill");
    expect(incoming).toContain("legacy-caller");
    await click(rows()[2]); // busy-skill
    await click(tab("연결"));
    const panel = document.getElementById("guide-detail-panel")!;
    expect(panel.textContent).toContain("call");
    expect(panel.textContent).toContain("shared-catalog");
    const catalogRow = Array.from(panel.querySelectorAll("button")).find(item => item.textContent?.includes("shared-catalog"))!;
    expect(catalogRow.textContent).not.toMatch(/call|include|pick|uses/);
  });

  it("쓰이는 곳 탭은 프로필, 출처, 조건, 실린 방식을 보인다", async () => {
    await mount(makeRequest().request);
    await click(rows()[2]); // busy-skill
    await click(tab("쓰이는 곳"));
    const usage = document.body.querySelector('[data-testid="skill-guide-usage"]')!;
    expect(usage.textContent).toContain("프로필 하나");
    expect(usage.textContent).toContain("공통 스킬 · 공통 / skills · os: windows");
    expect(usage.textContent).toContain("본문까지");
    expect(usage.textContent).toContain("프로필 둘");
    expect(usage.textContent).toContain("노드 설정");
    expect(usage.textContent).toContain("제목만");
  });

  it("쓰이는 곳 자료를 못 받으면 그 탭만 실패 안내와 다시 시도가 선다", async () => {
    await mount(makeRequest({ overviewStatus: 503 }).request);
    await click(rows()[2]);
    await click(tab("쓰이는 곳"));
    expect(document.getElementById("guide-detail-panel")!.textContent).toContain("프로필을 모으지 못했습니다");
    expect(button("다시 시도")).toBeTruthy();
  });

  it("검증 탭: 진단 목록, lint가 null이면 「보고에 없음」, report가 null이면 「검증 보고 없음」", async () => {
    await mount(makeRequest().request);
    await click(rows()[0]); // error-skill
    await click(tab("검증"));
    expect(document.body.querySelector('[data-testid="skill-guide-findings"]')!.textContent).toContain("E007");
    await click(rows()[4]); // missing-skill
    await click(tab("검증"));
    expect(document.getElementById("guide-detail-panel")!.textContent).toBe("보고에 없음");
  });

  it("report가 null이면 머리는 「검증 보고 없음」이고 다시 검증이 없다", async () => {
    await mount(makeRequest({ guides: { skills: skills.map(item => ({ ...item, lint: null })), catalogs: [], report: null } }).request);
    const head = document.body.querySelector('[data-testid="skill-catalog-report"]')!;
    expect(head.textContent).toBe("검증 보고 없음");
    expect(button("다시 검증")).toBeUndefined();
    await click(rows()[0]);
    await click(tab("검증"));
    expect(document.getElementById("guide-detail-panel")!.textContent).toBe("검증 보고 없음");
  });

  it("본문을 못 읽으면 본문 자리가 실패 안내로 바뀐다", async () => {
    await mount(makeRequest({ bodyStatus: 404 }).request);
    await click(rows()[0]);
    await flush();
    expect(document.getElementById("guide-detail-panel")!.textContent).toContain("본문을 읽지 못했습니다");
  });
});

describe("다시 검증", () => {
  it("머리에 보고 시각을 늘 적고, verify_job_id가 있을 때만 단추가 보인다", async () => {
    await mount(makeRequest().request);
    expect(document.body.querySelector('[data-testid="skill-catalog-report"]')!.textContent).toContain("11월 25일 14:30 검증");
    expect(button("다시 검증")).toBeTruthy();
  });

  it("verify_job_id가 없으면 단추가 없다", async () => {
    await mount(makeRequest({ guides: { skills, catalogs, report: report({ verify_job_id: null }) } }).request);
    expect(button("다시 검증")).toBeUndefined();
  });

  it("202 뒤 검증 중으로 바뀌어 15초마다 목록을 다시 읽다가 보고가 바뀌면 새 보고를 그린다", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const state: Setup = { guides: { skills, catalogs, report: report() } };
    const { request, calls } = makeRequest(state);
    await mount(request);
    await click(button("다시 검증"));
    expect(calls).toContain("POST /api/skill-guides/verify");
    expect(button("다시 검증")).toBeUndefined();
    expect(button("검증 중")!.getAttribute("aria-disabled")).toBe("true");
    await click(button("검증 중")); // 기다리는 동안 다시 눌러도 요청을 더 보내지 않는다
    expect(calls.filter(call => call === "POST /api/skill-guides/verify")).toHaveLength(1);
    expect(document.body.querySelector('[data-testid="skill-catalog-report"]')!.textContent).toContain("검증 중");
    const listReads = () => calls.filter(call => call === "GET /api/skill-guides").length;
    const before = listReads();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(listReads()).toBe(before + 1);
    expect(document.body.querySelector('[data-testid="skill-catalog-report"]')!.textContent).toContain("검증 중");
    state.guides = { skills, catalogs, report: report({ uploaded_at: "2026-11-25T06:10:00.000Z", generated_at: "2026-11-25T06:08:00.000Z" }) };
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(document.body.querySelector('[data-testid="skill-catalog-report"]')!.textContent).toContain("11월 25일 15:08 검증");
    expect(button("다시 검증")).toBeTruthy();
    // 끝난 뒤에는 더 읽지 않는다.
    const done = listReads();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(listReads()).toBe(done);
  });

  it("다시 검증이 202도 409도 아닌 실패(500)면 같은 단추 옆에 안내가 서고 단추와 초점이 그대로 남는다", async () => {
    const { request, calls } = makeRequest({ verify: 500 });
    await mount(request);
    const verifyButton = button("다시 검증")!;
    verifyButton.focus();
    await click(verifyButton);
    const head = document.body.querySelector('[data-testid="skill-catalog-report"]')!;
    expect(calls).toContain("POST /api/skill-guides/verify");
    expect(head.querySelector('[role="alert"]')!.textContent).toContain("요청하지 못했습니다");
    expect(head.textContent).not.toContain("검증 중");
    expect(button("다시 검증")).toBe(verifyButton);
    expect(document.activeElement).toBe(verifyButton);
  });

  it("10분이 지나도 보고가 안 바뀌면 멈추고 원래 단추로 돌아간다", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const { request, calls } = makeRequest();
    await mount(request);
    await click(button("다시 검증"));
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(button("다시 검증")).toBeTruthy();
    expect(document.body.querySelector('[data-testid="skill-catalog-report"]')!.textContent).not.toContain("검증 중");
    const reads = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls.length).toBe(reads);
  });

  it("409는 그 자리 안내로 두고 목록을 다시 읽지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const { request, calls } = makeRequest({ verify: 409 });
    await mount(request);
    const before = calls.length;
    await click(button("다시 검증"));
    expect(document.body.querySelector('[data-testid="skill-catalog-report"]')!.textContent).toContain("검증 작업이 없습니다");
    expect(button("다시 검증")).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls.length).toBe(before + 1);
  });
});
