import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { externalizeMcpSecrets, restoreMcpSecrets, consumeRunnerMcpSecrets } from
  "../../src/runner/mcp_secret_refs.js";

const secret = randomUUID();
const declarations = [
  { server: "external", field: "headers" as const, key: "X-Key", env: "TEST_MCP_SECRET" },
  { server: "local", field: "env" as const, key: "API_KEY", env: "TEST_MCP_SECRET" },
  { server: "internal", field: "headers" as const, key: "Authorization", env: "TEST_MCP_SECRET" },
];
const servers = [
  { type: "streamable_http" as const, name: "external", url: "https://example.test/mcp", headers: { "X-Key": secret } },
  { type: "stdio" as const, name: "local", command: "test", env: { API_KEY: secret } },
  { type: "streamable_http" as const, name: "internal", url: "https://example.test/mcp", headers: { Authorization: "session-scoped" } },
];

describe("runner MCP secret references", () => {
  it("removes matching registry secrets and restores them without changing session credentials", () => {
    const result = externalizeMcpSecrets(servers, declarations, { TEST_MCP_SECRET: secret });
    expect(result.refs).toEqual(declarations.slice(0, 2));
    expect(JSON.stringify(result.servers).includes(secret)).toBe(false);
    expect(JSON.stringify(result.servers).includes("session-scoped")).toBe(true);
    expect(JSON.stringify(restoreMcpSecrets(result.servers, result.refs, { TEST_MCP_SECRET: secret })) === JSON.stringify(servers)).toBe(true);
  });

  it("consumes the transport env before resolving and names missing variables only", () => {
    const result = externalizeMcpSecrets(servers, declarations, { TEST_MCP_SECRET: secret });
    const env: NodeJS.ProcessEnv = { SOUL_RUNNER_MCP_SECRETS: JSON.stringify({ TEST_MCP_SECRET: secret }) };
    const restored = consumeRunnerMcpSecrets(result.servers, result.refs, env);
    expect(JSON.stringify(restored) === JSON.stringify(servers)).toBe(true);
    expect(env.SOUL_RUNNER_MCP_SECRETS).toBeUndefined();
    const missing: NodeJS.ProcessEnv = { SOUL_RUNNER_MCP_SECRETS: "{}" };
    let message = "";
    try { consumeRunnerMcpSecrets(result.servers, result.refs, missing); }
    catch (error) { message = String(error); }
    expect(message.includes("TEST_MCP_SECRET")).toBe(true);
    expect(message.includes(secret)).toBe(false);
    expect(missing.SOUL_RUNNER_MCP_SECRETS).toBeUndefined();
  });
});
