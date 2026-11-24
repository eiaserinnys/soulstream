/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AgentMcpConnectionPane } from "./AgentMcpConnectionPane";

it("미리보기 실패 뒤 다시 시도하고 관리 밖 노드는 요청하지 않는다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const config = { current_revision: 1, servers: [], profiles: [], secrets: [], bindings: [], managed_nodes: [{ node_id: "n", connected: true, central_sync_supported: true, applied_revision: 1, ack: null }] };
  let calls = 0;
  const request = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/config")) return Response.json(config);
    calls++;
    if (calls === 1) return Response.json({ code: "MCP_NODE_UNAVAILABLE", message: "MCP preview unavailable" }, { status: 503 });
    return Response.json({ applied_mode: "local", applied_revision: 0, current_revision: 1, effective_backend: "sample", default_preset: null, isolation_enabled: false, normal: { runnable: true, servers: [] }, restricted: { runnable: true, servers: [] } });
  });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(<AgentMcpConnectionPane agentId="a" nodeId="n" request={request as typeof fetch} onEditProfile={() => {}} />); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain("노드에 연결할 수 없거나 노드가 이 기능을 받지 않습니다.");
    const button = [...host.querySelectorAll("button")].find(item => item.textContent === "다시 시도")!;
    await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(calls).toBe(2); expect(host.textContent).toContain("로컬 설정 사용 중");
    await act(async () => { root.render(<AgentMcpConnectionPane agentId="a" nodeId="outside" request={request as typeof fetch} onEditProfile={() => {}} />); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(calls).toBe(2); expect(host.textContent).toContain("이 노드는 중앙 MCP 관리 목록에 없습니다.");
    expect(host.textContent).not.toContain("선택 노드 실행 미리보기");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("연결 해제 선택은 저장된 미리보기를 숨기고 같은 이름에 ID를 붙인다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const config = { current_revision: 2, servers: [], secrets: [], managed_nodes: [{ node_id: "n", connected: true, central_sync_supported: true, applied_revision: 2, ack: null }],
    profiles: ["p1", "p2"].map(id => ({ id, name: "같은 이름", description: null, mcp_servers: [], hosted_tools: [], node_scope: ["n"], version: 1 })),
    bindings: [{ agent_id: "a", node_id: "n", mcp_profile_id: "p1", version: 1 }] };
  const request = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/config") ? Response.json(config) : Response.json({ applied_mode: "central", applied_revision: 2, current_revision: 2, effective_backend: "sample", default_preset: null, isolation_enabled: false, normal: { runnable: true, servers: [{ server_id: "s", name: "이전 서버", type: "stdio", included: true }] }, restricted: { runnable: true, servers: [] } }));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(<AgentMcpConnectionPane agentId="a" nodeId="n" request={request as typeof fetch} onEditProfile={() => {}} />); await new Promise(resolve => setTimeout(resolve, 0)); });
    const select = host.querySelector("select")!;
    expect([...select.options].map(item => item.textContent)).toEqual(["연결 안 함", "p1", "p2"]);
    expect(host.textContent).toContain("이전 서버");
    const before = request.mock.calls.filter(([url]) => String(url).includes("/preview?")).length;
    await act(async () => { select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.textContent).toContain("연결을 뗀 뒤의 미리보기는 저장한 뒤에 볼 수 있습니다.");
    expect(host.textContent).not.toContain("이전 서버");
    expect(request.mock.calls.filter(([url]) => String(url).includes("/preview?")).length).toBe(before);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("선택 노드의 연결과 미리보기를 보여 주고 선택한 노드에 판을 확인해 저장한다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  const config = { current_revision: 4, secrets: [], managed_nodes: ["n1", "n2"].map(node_id => ({ node_id, connected: true, central_sync_supported: true, applied_revision: 4, ack: null })),
    servers: [{ id: "s", name: "서버", type: "stdio", config: {}, icon: null, version: 1, node_scope: ["n1"], node_overrides: {} }],
    profiles: [{ id: "p", name: "프로필", description: null, mcp_servers: ["s"], hosted_tools: [], node_scope: ["n1"], version: 1 }],
    bindings: [{ agent_id: "agent", node_id: "n1", mcp_profile_id: "p", version: 2 }, { agent_id: "other", node_id: "n2", mcp_profile_id: "p", version: 1 }] };
  const preview = { applied_mode: "central", applied_revision: 4, current_revision: 4, effective_backend: "sample", default_preset: null, isolation_enabled: true,
    normal: { runnable: true, servers: [{ server_id: "s", name: "서버", type: "stdio", included: true, node_override: true }] },
    restricted: { runnable: false, blocked_reason: "실행할 수 없습니다", servers: [] } };
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === "/api/mcp/config") return Response.json(config);
    if (String(url).includes("/preview?")) return Response.json(preview);
    if (init?.method === "PUT") return Response.json({ current_revision: 5, bindings: [] });
    throw new Error(String(url));
  });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const click = async (text: string) => act(async () => { const b = [...host.querySelectorAll("button")].find(item => item.textContent?.trim() === text); if (!b) throw new Error(text); b.click(); });
  try {
    await act(async () => { root.render(<AgentMcpConnectionPane agentId="agent" nodeId="n1" request={request as typeof fetch} onEditProfile={() => {}} />); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain("중앙 판 4 일치");
    expect(host.textContent).toContain("노드 덮어쓰기 적용");
    expect(host.textContent).toContain("포함");
    expect(host.textContent).toContain("other (n2)");
    await click("연결 저장");
    expect(request).toHaveBeenCalledWith("/api/mcp/agents/agent", expect.objectContaining({ method: "PUT", body: JSON.stringify({ node_ids: ["n1"], mcp_profile_id: "p", expected_version: 2, expected_revision: 4 }) }));
    expect(host.querySelector('[role="status"]')?.textContent).toContain("저장");
    const otherNode = [...host.querySelectorAll("label")].find(label => label.textContent?.trim() === "n2");
    await act(async () => { (otherNode?.querySelector('[role="checkbox"]') as HTMLElement).click(); });
    expect(host.textContent).not.toContain("연결을 저장했습니다.");
    await click("격리 세션");
    expect(host.textContent).toContain("실행할 수 없습니다");
    expect(host.textContent).not.toContain("노드 덮어쓰기 적용");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
