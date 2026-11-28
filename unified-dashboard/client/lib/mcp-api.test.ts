import { createI18n } from "@soulstream/i18n";
import { describe, expect, it, vi } from "vitest";
import { createMcpApi, McpApiError, mcpRequestErrorText } from "./mcp-api";

describe("MCP 관리 API", () => {
  const ko = createI18n("ko").t;
  const en = createI18n("en").t;
  it("오류 응답 본문이 null이어도 HTTP 오류를 보존한다", async () => {
    const request = vi.fn(async () => Response.json(null, { status: 503 }));
    await expect(createMcpApi(request).previewAgentMcp("agent", "node"))
      .rejects.toMatchObject({ status: 503, code: "" } satisfies Partial<McpApiError>);
  });
  it.each([
    [403, "MCP_NODE_NOT_MANAGED", "English", "이 노드는 중앙 MCP 관리 목록에 없습니다."],
    [403, "MCP_SERVER_OUT_OF_SCOPE", "English", "이 서버는 이 노드 범위에 없습니다."],
    [403, "MCP_PORTABLE_NODE", "English", "무설치 노드는 중앙 MCP 설정을 받지 않습니다."],
    [403, "", "Admin access required", "관리자만 볼 수 있습니다."],
    [404, "MCP_PROFILE_NOT_FOUND", "Profile not found", "에이전트, 프로필이나 서버를 찾지 못했습니다. 다시 읽어 주세요."],
    [503, "MCP_NODE_UNAVAILABLE", "MCP preview unavailable", "노드에 연결할 수 없거나 노드가 이 기능을 받지 않습니다."],
    [503, "MCP_NODE_UNAVAILABLE", "이 노드는 중앙 MCP 설정을 받지 않습니다.", "이 노드는 중앙 MCP 설정을 받지 않습니다."],
  ])("HTTP %s %s 오류를 한국어로 안내한다", (status, code, message, expected) => {
    expect(mcpRequestErrorText(new McpApiError(status, code, message), ko)).toBe(expected);
  });
  it("maps the same server error code in English without changing the wire message", () => {
    const error = new McpApiError(403, "MCP_SERVER_OUT_OF_SCOPE", "Server is out of scope");
    expect(mcpRequestErrorText(error, en)).toBe("This server isn’t assigned to this node.");
    expect(error.message).toBe("Server is out of scope");
  });
  it("관리자 거부의 detail을 읽는다", async () => {
    const request = vi.fn().mockImplementation(async () => Response.json({ detail: "Admin access required" }, { status: 403 }));
    await expect(createMcpApi(request).previewAgentMcp("agent", "node")).rejects.toMatchObject({ status: 403, message: "Admin access required" });
    await expect(createMcpApi(request).testMcpServer({ node_id: "node", server_id: "server" })).rejects.toMatchObject({ status: 403, message: "Admin access required" });
  });
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
