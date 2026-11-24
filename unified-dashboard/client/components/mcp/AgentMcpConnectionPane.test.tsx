/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AgentMcpConnectionPane } from "./AgentMcpConnectionPane";

it("선택 노드의 연결과 미리보기를 보여 주고 선택한 노드에 판을 확인해 저장한다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
    await click("격리 세션");
    expect(host.textContent).toContain("실행할 수 없습니다");
    expect(host.textContent).not.toContain("노드 덮어쓰기 적용");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
