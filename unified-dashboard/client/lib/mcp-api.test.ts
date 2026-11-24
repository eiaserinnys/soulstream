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
});
