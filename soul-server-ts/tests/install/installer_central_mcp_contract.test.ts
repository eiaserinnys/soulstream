import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../../src/agent_registry.js";
import { isPortableMcpNode } from "../../src/mcp_central/state.js";
import { buildRegistrationMsg } from "../../src/upstream/registration.js";
import { McpConfigCommands } from "../../src/upstream/mcp_config_commands.js";

describe("portable central MCP contract", () => {
  it.each([
    [{ PORTABLE_LOCAL_MCP_AUTHORIZATION: "fake" }, {}, false],
    [{}, {}, false],
    [{ SOULSTREAM_PORTABLE_NODE: "1" }, {}, true],
    [{ PORTABLE_LOCAL_MCP_AUTHORIZATION: "fake" }, { model_catalog_path: "/catalog" }, true],
  ])("uses one classification for registration and sync", async (env, manifest, expected) => {
    const portable = isPortableMcpNode(env, manifest);
    expect(portable).toBe(expected);
    const msg = buildRegistrationMsg({ nodeId: "test", host: "localhost", port: 1, userName: "", agentRegistry: new AgentRegistry([]), isPortableNode: portable });
    expect(Boolean(msg.capabilities.central_mcp_config_v1)).toBe(!expected);
    const commands = new McpConfigCommands(undefined, undefined, portable);
    await expect(commands.sync({})).rejects.toMatchObject({ code: expected ? "MCP_PORTABLE_NODE" : "INVALID_MCP_CENTRAL_SYNC" });
  });
});
