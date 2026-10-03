import { describe, expect, it } from "vitest";
import { loadOrchServerEnvironment } from "../src/config.js";

const base = { ENVIRONMENT: "test", HOST: "127.0.0.1", DATABASE_URL: "unused",
  CLAUDE_OAUTH_CLIENT_ID: "test", CLAUDE_OAUTH_CALLBACK_URL: "https://example.test/callback" };
const enabled = { ...base, NODE_NAME: "test-node", MCP_EXTERNAL_INGRESS_ENABLED: "true",
  MCP_EXTERNAL_INGRESS_PATH: "/dot", MCP_EXTERNAL_INGRESS_SOURCE: "dot",
  MCP_EXTERNAL_INGRESS_DISPLAY_NAME: "Dot", MCP_EXTERNAL_INGRESS_BEARER_TOKEN: "test-dot" };
describe("orchestrator external ingress configuration", () => {
  it("defaults off with optional node identity", () => {
    expect(loadOrchServerEnvironment(base)).toMatchObject({ node_name: null,
      mcp_external_ingress_enabled: false, mcp_allowed_hosts: ["localhost", "127.0.0.1"] });
  });
  it("maps explicit ingress configuration", () => {
    expect(loadOrchServerEnvironment({ ...enabled, MCP_ALLOWED_HOSTS: " dot.example, localhost ",
      MCP_EXTERNAL_EVENTS_STATE_FILE: "/tmp/test-events.json" })).toMatchObject({
      node_name: "test-node", mcp_external_ingress_enabled: true, mcp_external_ingress_path: "/dot",
      mcp_external_ingress_source: "dot", mcp_external_ingress_display_name: "Dot",
      mcp_external_ingress_bearer_token: "test-dot", mcp_external_events_state_file: "/tmp/test-events.json",
      mcp_allowed_hosts: ["dot.example", "localhost"] });
  });
  it.each(["NODE_NAME", "MCP_EXTERNAL_INGRESS_PATH", "MCP_EXTERNAL_INGRESS_SOURCE",
    "MCP_EXTERNAL_INGRESS_DISPLAY_NAME", "MCP_EXTERNAL_INGRESS_BEARER_TOKEN"])("requires %s only when enabled", key => {
    const env: Record<string, string> = { ...enabled }; delete env[key];
    expect(() => loadOrchServerEnvironment(env)).toThrow(key);
  });
  it.each([
    { NODE_NAME: " " }, { MCP_EXTERNAL_INGRESS_ENABLED: "yes" },
    { MCP_EXTERNAL_INGRESS_SOURCE: "internal" }, { MCP_EXTERNAL_INGRESS_SOURCE: "browser" },
    { MCP_EXTERNAL_INGRESS_SOURCE: "Dot" }, { MCP_EXTERNAL_INGRESS_PATH: "/mcp" },
    { MCP_EXTERNAL_INGRESS_PATH: "/mcp/internal" }, { MCP_EXTERNAL_INGRESS_PATH: "/dot/" },
    { MCP_EXTERNAL_EVENTS_STATE_FILE: "relative" },
    { AUTH_BEARER_TOKEN: "test-dot" },
  ])("rejects unsafe ingress configuration %j", override => {
    expect(() => loadOrchServerEnvironment({ ...enabled, ...override })).toThrow();
  });
  it("does not open a subscription file while disabled", () => {
    expect(() => loadOrchServerEnvironment({ ...base, MCP_EXTERNAL_EVENTS_STATE_FILE: "/tmp/state" })).toThrow(/MCP_EXTERNAL_INGRESS_ENABLED/);
  });
});
