import { describe, expect, it, vi } from "vitest";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import type { CallToolResult } from "@soulstream/mcp-contract";

describe("list_user_messages MCP response", () => {
  it("serializes attachment fields from the repository row", async () => {
    const listUserMessages = vi.fn(async () => ({
      rows: [{
        session_id: "session-1",
        event_id: 17,
        created_at: new Date("2026-10-05T01:00:00.000Z"),
        source: "browser",
        email: null,
        user_id: "user-1",
        display_name: "Caller",
        session_title: "Session",
        node_id: "payload-node",
        agent_id: null,
        input_id: "input-17",
        purpose: "chat",
        text: "",
        text_chars: 0,
        attachment_ids: ["asset-17"],
        attachments: ["/legacy/path-17"],
        attachment_count: 1,
      }],
      total: 1,
    }));
    const options = {
      sessions: { repositoryProvider: async () => ({ eventReads: { listUserMessages } }) },
    } as unknown as McpHostOptions;

    const result = await executeMcpTool(options, "list_user_messages" as never, {
      since: "2026-10-05T00:00:00+00:00",
      until: "2026-10-06T00:00:00+00:00",
    }, { principal: "internal", callerSessionId: null, nodeId: "node-1" }) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      total: 1,
      messages: [{
        event_id: 17,
        input_id: "input-17",
        purpose: "chat",
        node_id: "payload-node",
        text: "",
        text_chars: 0,
        attachment_ids: ["asset-17"],
        attachments: ["/legacy/path-17"],
        attachment_count: 1,
        truncated: false,
      }],
    });
  });
});
