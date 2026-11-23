import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentProfileSchema } from "@soulstream/agent-profile-contract";
import { McpConfigService } from "../src/mcp_config_service.js";
import { makeTempDirSync } from "./helpers/temp_dir.js";

const agent = AgentProfileSchema.parse({ id: "agent", name: "Agent", backend: "codex", workspace_dir: "/tmp/agent", mcp_profile: "local" });
const unbound = { ...agent, id: "unbound" };
const snapshot = (value: string) => ({
  registry: { servers: [
    { id: "http", type: "streamable_http", url: `https://example.test/?license=${value}`, headers: { "X-License": value } },
    { id: "stdio", type: "stdio", command: "node", env: { LICENSE: value } },
  ] },
  profiles: { profiles: [{ id: "central", mcp_servers: ["http", "stdio"], hosted_tools: [{ type: "hosted_mcp", server_label: "hosted", server_url: `https://example.test/?license=${value}`, authorization: value, headers: { "X-License": value } }] }] },
  agent_bindings: { agent: "central" },
});

describe("central MCP configuration", () => {
  let dir: string;
  let marker: string;
  let service: McpConfigService;
  beforeEach(() => {
    dir = makeTempDirSync("mcp-central-");
    marker = path.join(dir, "mcp-central-mode.json");
    fs.writeFileSync(path.join(dir, "mcp-registry.yaml"), "servers:\n  - id: local-server\n    type: stdio\n    command: local-command\n");
    fs.writeFileSync(path.join(dir, "mcp-profiles.yaml"), "profiles:\n  - id: local\n    mcp_servers: [local-server]\n");
    service = new McpConfigService({ agentsConfigPath: path.join(dir, "agents.yaml"), modePath: marker, processEnv: { FAKE_VAR: "fake-secret-env" } });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("uses runtime and central bindings, and exposes only display and the value-free marker", async () => {
    await service.applyCentralSync({ revision: 4, runtime: snapshot("fake-secret-runtime"), display: snapshot("{{secret:ref}}") });
    expect(service.resolveMcpProfile(agent)?.mcp_servers[0]).toMatchObject({ url: "https://example.test/?license=fake-secret-runtime" });
    expect(service.resolveMcpProfile(unbound)).toBeUndefined();
    expect(service.effectiveAgentMcpProfileId(agent)).toBe("central");
    expect(JSON.stringify([service.listRegistry(), service.listProfiles()])).not.toContain("fake-secret-runtime");
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual({ central_mode: true, revision: 4 });
    expect(fs.readFileSync(marker, "utf8")).not.toContain("fake-secret-runtime");
  });

  it("expands node environment values in runtime fields and rejects unresolved values", async () => {
    await service.applyCentralSync({ revision: 1, runtime: snapshot("{{env:FAKE_VAR}}"), display: snapshot("{{env:FAKE_VAR}}") });
    const resolved = service.resolveMcpProfile(agent)!;
    expect(resolved.mcp_servers[0]).toMatchObject({ url: "https://example.test/?license=fake-secret-env", headers: { "X-License": "fake-secret-env" } });
    expect(resolved.mcp_servers[1]).toMatchObject({ env: { LICENSE: "fake-secret-env" } });
    expect(resolved.hosted_tools[0]).toMatchObject({ authorization: "fake-secret-env", server_url: "https://example.test/?license=fake-secret-env", headers: { "X-License": "fake-secret-env" } });
    await service.applyCentralSync({ revision: 2, runtime: snapshot("{{env:MISSING}}"), display: snapshot("x") });
    expect(() => service.resolveMcpProfile(agent)).toThrow(/MISSING.*not set/);
    await service.applyCentralSync({ revision: 3, runtime: snapshot("{{secret:x}}"), display: snapshot("x") });
    expect(() => service.resolveMcpProfile(agent)).toThrow(/secret/);
  });

  it("waits for a first sync after restart, and times out when none arrives", async () => {
    fs.writeFileSync(marker, JSON.stringify({ central_mode: true, revision: 7 }));
    const restarted = new McpConfigService({ agentsConfigPath: path.join(dir, "agents.yaml"), modePath: marker });
    expect(() => restarted.resolveMcpProfile(agent)).toThrow(/CENTRAL_MCP_CONFIG_NOT_SYNCED/);
    const waiting = restarted.waitForInitialCentralSync(1000);
    await restarted.applyCentralSync({ revision: 8, runtime: snapshot("x"), display: snapshot("x") });
    await waiting;
    expect(restarted.resolveMcpProfile(agent)?.mcp_servers[0]).toMatchObject({ url: "https://example.test/?license=x" });
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual({ central_mode: true, revision: 8 });
    const pending = new McpConfigService({ agentsConfigPath: path.join(dir, "agents.yaml"), modePath: marker });
    await pending.waitForInitialCentralSync(5);
    expect(() => pending.resolveMcpProfile(agent)).toThrow(/CENTRAL_MCP_CONFIG_NOT_SYNCED/);
  });

  it("keeps the previous snapshot and marker when validation fails", async () => {
    await service.applyCentralSync({ revision: 1, runtime: snapshot("good"), display: snapshot("display") });
    const duplicate = snapshot("bad");
    duplicate.registry.servers.push(duplicate.registry.servers[0]!);
    await expect(service.applyCentralSync({ revision: 2, runtime: duplicate, display: snapshot("display") })).rejects.toThrow();
    const missing = snapshot("bad");
    missing.agent_bindings.agent = "missing";
    await expect(service.applyCentralSync({ revision: 3, runtime: missing, display: snapshot("display") })).rejects.toThrow();
    expect(service.resolveMcpProfile(agent)?.mcp_servers[0]).toMatchObject({ url: "https://example.test/?license=good" });
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual({ central_mode: true, revision: 1 });
  });
});
