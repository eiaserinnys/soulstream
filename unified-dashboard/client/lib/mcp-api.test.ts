import { describe, expect, it, vi } from "vitest";
import { createMcpApi, McpApiError } from "./mcp-api";

describe("MCP 관리 API", () => {
  it("같은 출처 인증과 기대 판으로 서버를 저장한다", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ current_revision: 2, server: { id: "example" } }),
          { status: 200 },
        ),
      );
    const api = createMcpApi(request);
    await api.putServer("example", {
      type: "streamable_http",
      config: { url: "https://example.invalid/mcp" },
      node_scope: ["node"],
      expected_version: 3,
    });
    expect(request).toHaveBeenCalledWith(
      "/api/mcp/servers/example",
      expect.objectContaining({
        method: "PUT",
        credentials: "same-origin",
        body: expect.stringContaining('"expected_version":3'),
      }),
    );
  });
  it("충돌 코드와 메시지를 보존한다", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ code: "MCP_SERVER_INUSE", message: "profile-a" }),
          { status: 409 },
        ),
      );
    await expect(
      createMcpApi(request).deleteServer("example", 3),
    ).rejects.toMatchObject({
      status: 409,
      code: "MCP_SERVER_INUSE",
      message: "profile-a",
    } satisfies Partial<McpApiError>);
  });
  it("에이전트 연결과 시험, 미리보기를 지정한 노드로 요청한다", async () => {
    const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const api = createMcpApi(request);
    await api.setAgentMcpBinding("agent / a", { node_ids: ["node one"], mcp_profile_id: "profile", expected_version: 2, expected_revision: 7, fork: true });
    expect(request).toHaveBeenNthCalledWith(1, "/api/mcp/agents/agent%20%2F%20a", expect.objectContaining({
      method: "PUT", credentials: "same-origin", body: JSON.stringify({ node_ids: ["node one"], mcp_profile_id: "profile", expected_version: 2, expected_revision: 7, fork: true }),
    }));
    await api.testMcpServer({ node_id: "node one", server_id: "server" });
    expect(request).toHaveBeenNthCalledWith(2, "/api/mcp/servers/test", expect.objectContaining({ method: "POST", body: JSON.stringify({ node_id: "node one", server_id: "server" }) }));
    const draft = { node_id: "node one", draft_server: { id: "draft", type: "stdio" as const, config: { command: "run" }, node_scope: ["node one"] }, inline_secrets: { fake: "placeholder" } };
    await api.testMcpServer(draft);
    expect(request).toHaveBeenNthCalledWith(3, "/api/mcp/servers/test", expect.objectContaining({ body: JSON.stringify(draft) }));
    await api.previewAgentMcp("agent / a", "node one", "profile & b");
    expect(request).toHaveBeenNthCalledWith(4, "/api/mcp/agents/agent%20%2F%20a/preview?node_id=node%20one&mcp_profile_id=profile%20%26%20b", expect.objectContaining({ method: "GET" }));
    await api.previewAgentMcp("agent", "node");
    expect(request).toHaveBeenNthCalledWith(5, "/api/mcp/agents/agent/preview?node_id=node", expect.objectContaining({ method: "GET" }));
  });
});
