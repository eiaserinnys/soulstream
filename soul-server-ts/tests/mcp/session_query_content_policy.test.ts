import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import type { McpRuntime } from "../../src/mcp/runtime.js";
import { registerSessionQueryTools } from "../../src/mcp/tools/session_query.js";

describe("list_session_events tool content policy", () => {
  it.each([
    ["truncate", 4, '{"te…(truncated)'],
    ["omit", undefined, "(omitted)"],
    ["full", undefined, { text: "abcdefgh" }],
  ] as const)("keeps the %s output contract", async (policy, truncateChars, expected) => {
    const registered = new Map<string, {
      handler: (input: Record<string, unknown>, extra: { signal: AbortSignal }) =>
        Promise<CallToolResult>;
    }>();
    const server = {
      registerTool(name: string, _config: unknown, handler: unknown) {
        registered.set(name, {
          handler: handler as (input: Record<string, unknown>, extra: { signal: AbortSignal }) =>
            Promise<CallToolResult>,
        });
      },
    } as unknown as McpServer;
    const runtime = {
      db: {
        getSession: async () => ({ session_id: "session-1" }),
        readEvents: async () => [{
          id: 1,
          event_type: "tool_result",
          payload: { text: "abcdefgh" },
          created_at: new Date("2026-09-29T00:00:00.000Z"),
        }],
        countEvents: async () => 1,
      },
    } as unknown as McpRuntime;
    registerSessionQueryTools(server, runtime);

    const result = await registered.get("list_session_events")!.handler({
      session_id: "session-1",
      tool_content: policy,
      ...(truncateChars === undefined ? {} : { tool_truncate_chars: truncateChars }),
    }, { signal: new AbortController().signal });

    expect(result.structuredContent?.events).toEqual([expect.objectContaining({ event: expected })]);
  });
});
