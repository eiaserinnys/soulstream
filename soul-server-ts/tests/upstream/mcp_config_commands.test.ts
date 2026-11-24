import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "../../src/agent_registry.js";
import { McpConfigService } from "../../src/mcp_config_service.js";
import { CommandDispatcher } from "../../src/upstream/dispatcher.js";
import { buildRegistrationMsg } from "../../src/upstream/registration.js";
import { makeTempDirSync } from "../helpers/temp_dir.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup(processEnv?: Record<string, string | undefined>) {
  const dir = makeTempDirSync("mcp-command-"); dirs.push(dir);
  const agentsConfigPath = path.join(dir, "agents.yaml");
  fs.writeFileSync(agentsConfigPath, "agents:\n  - id: agent\n    name: Agent\n    backend: codex\n    workspace_dir: /tmp/agent\n    mcp_profile: local\n");
  fs.writeFileSync(path.join(dir, "mcp-registry.yaml"), "servers:\n  - id: srv\n    type: stdio\n    command: node\n    env:\n      KEY: { env: FAKE_KEY }\n");
  fs.writeFileSync(path.join(dir, "mcp-profiles.yaml"), "profiles:\n  - id: local\n    mcp_servers: [srv]\n");
  const service = new McpConfigService({ agentsConfigPath, modePath: path.join(dir, "marker.json"), processEnv });
  const send = vi.fn(async (_data: unknown) => {});
  const rebuild = vi.fn();
  const logs: string[] = [];
  const logger = pino({ level: "trace" }, { write: (line: string) => logs.push(line) });
  const registry = new AgentRegistry([]);
  const dispatcher = new CommandDispatcher({ send, logger, nodeId: "test", agentRegistry: registry,
    taskManager: {} as never, taskExecutor: {} as never,
    reflectionRuntime: { mcpConfigService: service, agentsConfigPath } as never,
    agentProfileSource: { rebuild } as never });
  return { service, send, rebuild, logs, dispatcher, registry };
}
const snap = { registry: { servers: [{ id: "x", type: "streamable_http", url: "https://example.test/?license=fake-secret-command" }] }, profiles: { profiles: [{ id: "p", mcp_servers: ["x"] }] }, agent_bindings: { agent: "p" } };

describe("MCP configuration commands", () => {
  it("applies a valid sync, rebuilds once and never logs payloads", async () => {
    const { dispatcher, send, rebuild, logs } = setup();
    await dispatcher.dispatch({ type: "mcp_central_sync", requestId: "one", revision: 3, runtime: snap, display: snap });
    expect(send).toHaveBeenCalledWith({ type: "mcp_central_sync", requestId: "one", success: true, data: { applied_revision: 3 } });
    expect(rebuild).toHaveBeenCalledTimes(1);
    await dispatcher.dispatch({ type: "mcp_central_sync", requestId: "bad", mode: "central", revision: -1, runtime: snap });
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ code: expect.any(String), requestId: "bad" }));
    expect(logs.join("")).not.toContain("fake-secret-command");
  });

  it("rejects central sync on a portable node", async () => {
    const { dispatcher, send, rebuild } = setup({ PORTABLE_LOCAL_MCP_AUTHORIZATION: "fake-secret-portable" });
    await dispatcher.dispatch({ type: "mcp_central_sync", requestId: "portable", revision: 1, runtime: snap, display: snap });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ code: "MCP_PORTABLE_NODE" }));
    expect(rebuild).not.toHaveBeenCalled();
    await dispatcher.dispatch({ type: "test_mcp_server", requestId: "test", server: { id: "s", name: "s", type: "stdio", config: { command: "node" } } });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ code: "MCP_PORTABLE_NODE" }));
    await dispatcher.dispatch({ type: "preview_agent_mcp", requestId: "preview", agent_id: "agent" });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ code: "MCP_PORTABLE_NODE" }));
  });

  it("does not advertise central MCP support on a portable node", () => {
    vi.stubEnv("PORTABLE_LOCAL_MCP_AUTHORIZATION", "fake-secret-portable");
    try {
      const { registry } = setup();
      expect(buildRegistrationMsg({ nodeId: "portable", host: "localhost", port: 1, userName: "", agentRegistry: registry }).capabilities).not.toHaveProperty("central_mcp_config_v1");
    } finally { vi.unstubAllEnvs(); }
  });

  it("advertises central MCP support", () => {
    const { registry } = setup();
    expect(buildRegistrationMsg({ nodeId: "test", host: "localhost", port: 1, userName: "", agentRegistry: registry }).capabilities).toMatchObject({ central_mcp_config_v1: true });
  });
});
