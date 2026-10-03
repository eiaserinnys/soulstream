import { describe, expect, it } from "vitest";

import { parseEnv } from "../../src/config.js";
import { buildMcpServerOptions } from "../../src/runtime/mcp_server_options.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";

const minimal = {
  SOULSTREAM_NODE_ID: "node-test",
  SOULSTREAM_UPSTREAM_URL: "ws://localhost:5200/ws/node",
  EVENT_OUTBOX_DIR: "/tmp/soulstream-mcp-options-test",
};

describe("MCP server option composition", () => {
  it("does not mount MCP routes while MCP remains disabled", () => {
    expect(buildMcpServerOptions(
      parseEnv(minimal),
      {} as McpRuntime,
    )).toBeUndefined();
  });
});
