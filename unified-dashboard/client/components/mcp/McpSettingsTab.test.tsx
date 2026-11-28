/** @vitest-environment jsdom */
import { createI18n } from "@soulstream/i18n";
import { I18nextProvider } from "react-i18next";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { McpSettingsTab } from "./McpSettingsTab";
import { McpServerEditor } from "./McpServerEditor";
import type { McpConfig, McpTestInput } from "../../lib/mcp-api";

const sample = (): McpConfig => ({
  current_revision: 12,
  managed_nodes: [{ node_id: "example-node", connected: true, central_sync_supported: true, applied_revision: 12, ack: { revision: 12 } }],
  servers: [{ id: "example", name: "가짜 서버", type: "streamable_http", version: 7,
    config: { url: "https://example.invalid/mcp?first=%7B%7Bsecret%3Afake-first%7D%7D&second=%7B%7Bsecret%3Afake-second%7D%7D", headers: { Authorization: "Bearer {{secret:fake-auth}}", Origin: { env: "EXAMPLE_ORIGIN" } }, timeout: 30 },
    node_scope: ["example-node"], node_overrides: { "example-node": { type: "sse", config: { url: "https://override.example.invalid", headers: { Origin: { env: "OVERRIDE_ORIGIN" } }, timeout: 45 } } },
    icon: { kind: "symbol", name: "plug", color: "node-user" } }],
  profiles: [], bindings: [], secrets: ["fake-first", "fake-second", "fake-auth"].map(name => ({ name, updated_at: null, servers: ["example"], profiles: [] })),
});
const click = async (element: Element | null | undefined) => { if (!element) throw new Error("요소 없음"); await act(async () => { (element as HTMLElement).click(); }); };
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find(item => item.textContent?.trim() === text);
const setInput = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

it("프로필에서 연결된 에이전트와 노드를 선택해 이동한다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const data = sample();
  data.profiles = [{ id: "profile-a", name: "프로필 A", description: null, mcp_servers: ["example"], hosted_tools: [], node_scope: ["example-node"], version: 1 }];
  data.bindings = [{ agent_id: "agent-a", node_id: "example-node", mcp_profile_id: "profile-a", version: 1 }];
  const open = vi.fn(), request = vi.fn(async () => Response.json(data));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(<McpSettingsTab request={request as typeof fetch} initialProfileId="profile-a" onOpenAgent={open} />); await new Promise(resolve => setTimeout(resolve, 0)); });
    await click(button(host, "agent-a (example-node)"));
    expect(open).toHaveBeenCalledWith("agent-a", "example-node");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("저장된 서버와 편집 중인 초안을 각각 선택 노드에서 시험한다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const config = sample(), test = vi.fn().mockResolvedValue({ ok: true, latency_ms: 23, tool_count: 2, tools: ["one", "two"], server_info: { name: "example", version: "1" } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<McpServerEditor server={config.servers[0]} config={config} busy={false} onEdit={() => {}} save={vi.fn()} remove={() => {}} rollback={() => {}} upload={vi.fn()} addToProfiles={vi.fn()} justCreated={false} dismissCreated={() => {}} test={test} />));
    await click(button(host, "연결 시험"));
    expect(test).toHaveBeenCalledWith({ node_id: "example-node", server_id: "example" });
    expect(host.textContent).toContain("23");
    expect(host.textContent).toContain("one");
    const name = [...host.querySelectorAll("label")].find(label => label.textContent?.includes("전송 이름"))!.querySelector("input")!;
    await setInput(name, "수정한 서버");
    await click(button(host, "연결 시험"));
    expect(test).toHaveBeenLastCalledWith(expect.objectContaining({ node_id: "example-node", draft_server: expect.objectContaining({ id: "example", name: "수정한 서버" }) }));
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it.each([
  ["ko", "연결 시험", "관리자만 볼 수 있습니다."],
  ["en", "Test", "Admins only."],
] as const)("shows the connection test permission error in %s", async (language, testLabel, permissionError) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const request = vi.fn(async (url: RequestInfo | URL) => String(url) === "/api/mcp/config"
    ? Response.json(sample())
    : Response.json({ detail: "Admin access required" }, { status: 403 }));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(<I18nextProvider i18n={createI18n(language)}><McpSettingsTab request={request as typeof fetch} /></I18nextProvider>); await new Promise(resolve => setTimeout(resolve, 0)); });
    await click(button(host, testLabel));
    expect(host.textContent).toContain(permissionError);
    expect(host.textContent).not.toContain("Admin access required");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it.each([
  ["config", "서버 정의를 확인해 주세요."],
  ["connect", "서버에 연결하지 못했습니다."],
  ["initialize", "서버가 MCP 초기화에 응하지 않았습니다."],
  ["list_tools", "도구 목록을 받지 못했습니다."],
  ["timeout", "제한 시간 안에 응답이 없었습니다."],
] as const)("연결 시험 %s 실패에서 기본 영어를 숨기고 추가 설명을 보여 준다", async (stage, guidance) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const config = sample();
  const test = vi.fn().mockResolvedValueOnce({ ok: false, latency_ms: 1, error_stage: stage, error_message: `MCP ${stage} failed` })
    .mockResolvedValueOnce({ ok: false, latency_ms: 1, error_stage: stage, error_message: "추가 설명" });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<McpServerEditor server={config.servers[0]} config={config} busy={false} onEdit={() => {}} save={vi.fn()} remove={() => {}} rollback={() => {}} upload={vi.fn()} addToProfiles={vi.fn()} justCreated={false} dismissCreated={() => {}} test={test} />));
    await click(button(host, "연결 시험"));
    expect(host.textContent).toContain(guidance);
    expect(host.textContent).not.toContain(`MCP ${stage} failed`);
    await click(button(host, "연결 시험"));
    expect(host.textContent).toContain(guidance);
    expect(host.textContent).toContain("추가 설명");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("편집한 값은 시험 요청의 inline_secrets로만 보내고 결과에서는 감춘다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const config = sample();
  let finish: (value: { ok: false; latency_ms: number; error_stage: "connect"; error_message: string }) => void = () => {};
  const test = vi.fn((_input: McpTestInput) => new Promise<{ ok: false; latency_ms: number; error_stage: "connect"; error_message: string }>(resolve => { finish = resolve; }));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<McpServerEditor server={config.servers[0]} config={config} busy={false} onEdit={() => {}} save={vi.fn()} remove={() => {}} rollback={() => {}} upload={vi.fn()} addToProfiles={vi.fn()} justCreated={false} dismissCreated={() => {}} test={test} />));
    await click(button(host, "값 교체"));
    await setInput(host.querySelector('input[type="password"]')!, "placeholder-value");
    await click(button(host, "연결 시험"));
    expect(button(host, "시험 중…")?.disabled).toBe(true);
    const sent = test.mock.calls[0][0] as { draft_server: unknown; inline_secrets: Record<string, string> };
    expect(Object.values(sent.inline_secrets)).toContain("placeholder-value");
    expect(JSON.stringify(sent.draft_server)).not.toContain("placeholder-value");
    await act(async () => finish({ ok: false, latency_ms: 1, error_stage: "connect", error_message: "오류 placeholder-value" }));
    expect(host.textContent).toContain("서버에 연결하지 못했습니다.");
    expect(host.textContent).toContain("오류 [비공개]");
    expect(host.textContent).not.toContain("placeholder-value");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("서버 편집기에서 적용 노드를 해제하면 덮어쓰기도 저장에서 빠진다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  const config = sample(), save = vi.fn().mockResolvedValue(true), host = document.createElement("div");
  document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<McpServerEditor server={config.servers[0]} config={config} busy={false} onEdit={() => {}} save={save} remove={() => {}} rollback={() => {}} upload={vi.fn()} addToProfiles={vi.fn()} justCreated={false} dismissCreated={() => {}} />));
    const label = [...host.querySelectorAll("label")].find(item => item.textContent?.trim() === "example-node")!;
    await click(label.querySelector('[role="checkbox"], input[type="checkbox"]'));
    await click(button(host, "저장"));
    expect(save).toHaveBeenCalledWith("example", expect.objectContaining({ scope: [], overrides: {} }), 7);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("설정 화면이 서버 정의를 보존해 기대 판으로 PUT하고 값 교체 입력을 지운다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldScroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = (() => Promise.resolve()) as unknown as typeof HTMLElement.prototype.scrollIntoView;
  const data = sample(), original = structuredClone(data.servers[0]);
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (String(url) === "/api/mcp/config") return Response.json(data);
    if (String(url) === "/api/mcp/servers/example" && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; requests.push({ method, body });
      data.servers[0] = { ...data.servers[0], version: data.servers[0].version + 1 };
      return Response.json({ current_revision: ++data.current_revision, server: data.servers[0] });
    }
    throw new Error(`예상하지 않은 요청: ${method} ${String(url)}`);
  });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(<McpSettingsTab request={request as typeof fetch} />); await new Promise(resolve => setTimeout(resolve, 0)); });
    await click(button(host, "저장"));
    expect(requests[0]?.body).toEqual({ name: original.name, type: original.type, config: original.config, node_scope: original.node_scope, node_overrides: original.node_overrides, icon: original.icon, inline_secrets: {}, expected_version: 7 });
    await click(button(host, "값 교체"));
    const secretInput = host.querySelector('input[type="password"]') as HTMLInputElement;
    await setInput(secretInput, "obviously-fake-value");
    await click(button(host, "저장"));
    expect(requests[1]?.body).toMatchObject({ expected_version: 8, inline_secrets: { "fake-auth": "obviously-fake-value" } });
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.innerHTML).not.toContain("obviously-fake-value");
    await click(button(host, "비밀값"));
    expect(host.textContent).toContain("사용처");
  } finally { await act(async () => root.unmount()); HTMLElement.prototype.scrollIntoView = oldScroll; host.remove(); vi.unstubAllGlobals(); }
});
