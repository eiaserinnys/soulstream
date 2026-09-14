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

  it("mounts a credential-separated external ingress only when enabled", () => {
    const options = buildMcpServerOptions(parseEnv({
      ...minimal,
      MCP_ENABLED: "true",
      AUTH_BEARER_TOKEN: "service-secret",
      MCP_EXTERNAL_INGRESS_ENABLED: "true",
      MCP_EXTERNAL_INGRESS_PATH: "/mcp/external-llm",
      MCP_EXTERNAL_INGRESS_SOURCE: "external-llm",
      MCP_EXTERNAL_INGRESS_DISPLAY_NAME: "External LLM",
      MCP_EXTERNAL_INGRESS_BEARER_TOKEN: "external-secret",
    }), {} as McpRuntime);

    expect(options?.externalIngress).toMatchObject({
      path: "/mcp/external-llm",
      source: "external-llm",
      displayName: "External LLM",
      auth: {
        requireAuth: true,
        bearerToken: "external-secret",
      },
    });
  });
});
