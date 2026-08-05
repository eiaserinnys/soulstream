import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { McpRuntime } from "../../src/mcp/runtime.js";
import {
  createGuardedMcpServer,
  guardMcpToolExecution,
  isDestructiveMcpTool,
} from "../../src/mcp/tool_access.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";

function makeRuntime(): McpRuntime {
  return {} as McpRuntime;
}

describe("외부 LLM destructive tool 경계", () => {
  it("delete_ 명명 규칙으로 신규 도구도 자동 분류한다", () => {
    expect(isDestructiveMcpTool("delete_session")).toBe(true);
    expect(isDestructiveMcpTool("delete_example")).toBe(true);
    expect(isDestructiveMcpTool("archive_task")).toBe(false);
  });

  it("명시적 destructiveHint가 접두어 추론을 양방향으로 덮어쓴다", () => {
    expect(isDestructiveMcpTool("purge_cache", {
      annotations: { destructiveHint: true },
    })).toBe(true);
    expect(isDestructiveMcpTool("delete_preview", {
      annotations: { destructiveHint: false },
    })).toBe(false);
  });

  it("batch_page_operations 내부 delete 연산도 destructive로 분류한다", () => {
    const warn = vi.fn();
    const runtime = {
      ...makeRuntime(),
      logger: { warn },
    } as unknown as McpRuntime;

    const blocked = withMcpRequestContext(
      { callerOrigin: "llm" },
      () => guardMcpToolExecution(runtime, "batch_page_operations", {
        operations: [{ op: "delete_block_subtree", block_id: "block-1" }],
      }),
    );

    expect(blocked?.isError).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      { callerOrigin: "llm", toolName: "batch_page_operations" },
      "Blocked destructive MCP tool for external LLM caller",
    );
  });

  it("내부 서버에는 delete 도구를 등록하고 destructiveHint를 자동 부여한다", () => {
    const registerTool = vi.fn();
    const guarded = createGuardedMcpServer(
      { registerTool } as unknown as McpServer,
      makeRuntime(),
    );

    guarded.registerTool("delete_example", { inputSchema: {} }, vi.fn());

    expect(registerTool).toHaveBeenCalledWith(
      "delete_example",
      expect.objectContaining({
        annotations: expect.objectContaining({ destructiveHint: true }),
      }),
      expect.any(Function),
    );
  });

  it("llm origin의 tools/list 표면에서는 delete 도구 등록을 생략한다", () => {
    const registerTool = vi.fn();

    withMcpRequestContext({ callerOrigin: "llm" }, () => {
      const guarded = createGuardedMcpServer(
        { registerTool } as unknown as McpServer,
        makeRuntime(),
      );
      guarded.registerTool("delete_example", { inputSchema: {} }, vi.fn());
      guarded.registerTool("archive_task", { inputSchema: {} }, vi.fn());
    });

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool).toHaveBeenCalledWith(
      "archive_task",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("llm origin은 비접두어 도구라도 명시적 destructiveHint면 등록하지 않는다", () => {
    const registerTool = vi.fn();

    withMcpRequestContext({ callerOrigin: "llm" }, () => {
      const guarded = createGuardedMcpServer(
        { registerTool } as unknown as McpServer,
        makeRuntime(),
      );
      guarded.registerTool(
        "purge_cache",
        {
          inputSchema: {},
          annotations: { destructiveHint: true },
        },
        vi.fn(),
      );
    });

    expect(registerTool).not.toHaveBeenCalled();
  });

  it("llm origin의 직접 delete 호출은 거부하고 감사 로그를 남긴다", () => {
    const warn = vi.fn();
    const runtime = {
      ...makeRuntime(),
      logger: { warn },
    } as unknown as McpRuntime;

    const blocked = withMcpRequestContext(
      { callerOrigin: "llm" },
      () => guardMcpToolExecution(runtime, "delete_session"),
    );

    expect(blocked?.isError).toBe(true);
    expect(blocked?.structuredContent).toEqual({
      error: 'MCP tool "delete_session" is not available to external LLM callers',
    });
    expect(warn).toHaveBeenCalledWith(
      { callerOrigin: "llm", toolName: "delete_session" },
      "Blocked destructive MCP tool for external LLM caller",
    );
  });
});
