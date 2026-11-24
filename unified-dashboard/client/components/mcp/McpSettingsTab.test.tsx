/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { McpSettingsTab } from "./McpSettingsTab";
import { McpServerEditor } from "./McpServerEditor";
import type { McpConfig } from "../../lib/mcp-api";

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

it("서버 편집기에서 적용 노드를 해제하면 덮어쓰기도 저장에서 빠진다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  const config = sample(), save = vi.fn().mockResolvedValue(true), host = document.createElement("div");
  document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<McpServerEditor server={config.servers[0]} config={config} busy={false} save={save} remove={() => {}} rollback={() => {}} upload={vi.fn()} addToProfiles={vi.fn()} justCreated={false} dismissCreated={() => {}} />));
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
