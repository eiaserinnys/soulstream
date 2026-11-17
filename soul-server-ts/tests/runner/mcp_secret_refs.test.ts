import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AgentProfileSchema } from "../../src/agent_registry.js";
import { externalizeMcpSecrets, consumeRunnerMcpSecrets } from "../../src/runner/mcp_secret_refs.js";

const fake = () => `fake-${randomUUID()}`;

describe("runner MCP secret references", () => {
  it("externalizes both locations into distinct slots and restores anonymous and duplicate servers", () => {
    const values = Array.from({ length: 6 }, fake);
    const agent = AgentProfileSchema.parse({ id: "test", name: "Test", backend: "openai-agents", workspace_dir: "/tmp",
      agents_sdk: { entry_agent: "a", agents: [{ id: "a", name: "A", instructions: "test", mcp_servers: [
        { type: "stdio", command: "test-a", env: { API_KEY: values[2] }, headers: { Authorization: values[3] } },
        { type: "stdio", command: "test-b", env: { API_KEY: values[4] } },
        { type: "streamable_http", name: "same", url: "https://example.test/c", headers: { Authorization: values[5] } },
      ] }] } });
    const config = { agent, resolvedMcpServers: [
      { type: "streamable_http" as const, name: "same", url: "https://example.test/a", headers: { Authorization: values[0]!, Empty: "" } },
      { type: "streamable_http" as const, name: "same", url: "https://example.test/b", headers: { Authorization: values[1]! } },
    ] };
    const converted = externalizeMcpSecrets(config);
    const raw = JSON.stringify(converted.config);
    expect(values.every((value) => !raw.includes(value))).toBe(true);
    expect(converted.refs).toHaveLength(6);
    expect(new Set(converted.refs.map((ref) => ref.env)).size).toBe(6);
    expect(converted.refs.filter((ref) => ref.location === "agent").map((ref) => ref.server)).toEqual(["#0", "#0", "#1", "same"]);
    const env: NodeJS.ProcessEnv = { SOUL_RUNNER_MCP_SECRETS: JSON.stringify(converted.secrets) };
    expect(consumeRunnerMcpSecrets(converted.config, converted.refs, env)).toEqual(config);
    expect(env.SOUL_RUNNER_MCP_SECRETS).toBeUndefined();
  });

  it("restores old refs by name and clears the transport", () => {
    const secret = fake();
    const config = { agent: AgentProfileSchema.parse({ id: "a", name: "A", backend: "codex", workspace_dir: "/tmp" }),
      resolvedMcpServers: [{ type: "streamable_http" as const, name: "remote", url: "https://example.test/mcp", headers: {} }] };
    const env = { SOUL_RUNNER_MCP_SECRETS: JSON.stringify({ OLD_KEY: secret }) };
    const restored = consumeRunnerMcpSecrets(config, [{ server: "remote", field: "headers", key: "X-Key", env: "OLD_KEY" }], env);
    expect(restored.resolvedMcpServers![0]!.headers!["X-Key"] === secret).toBe(true);
    expect(env.SOUL_RUNNER_MCP_SECRETS).toBeUndefined();
  });

  it("reports a missing slot without its value and clears the transport", () => {
    const secret = fake();
    const config = { agent: AgentProfileSchema.parse({ id: "a", name: "A", backend: "codex", workspace_dir: "/tmp" }),
      resolvedMcpServers: [{ type: "streamable_http" as const, name: "remote", url: "https://example.test/mcp", headers: { "X-Key": secret } }] };
    const converted = externalizeMcpSecrets(config);
    for (const payload of ["{}", JSON.stringify({ [converted.refs[0]!.env]: "" })]) {
      const env: NodeJS.ProcessEnv = { SOUL_RUNNER_MCP_SECRETS: payload };
      let message = "";
      try { consumeRunnerMcpSecrets(converted.config, converted.refs, env); } catch (error) { message = String(error); }
      expect(message).toContain("remote"); expect(message).toContain("headers"); expect(message).toContain("X-Key");
      expect(message.includes(secret)).toBe(false);
      expect(env.SOUL_RUNNER_MCP_SECRETS).toBeUndefined();
    }
  });
});
