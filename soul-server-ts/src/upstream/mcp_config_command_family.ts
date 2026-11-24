import type { CommandHandlerMap, SendFn } from "./command_family.js";
import type { McpConfigCommands } from "./mcp_config_commands.js";

export function createMcpConfigCommandFamily(deps: { send: SendFn; commands: McpConfigCommands }): CommandHandlerMap {
  return {
    mcp_central_sync: async (cmd) => { await deps.send(await deps.commands.sync(cmd)); },
    test_mcp_server: async (cmd) => { await deps.send(await deps.commands.test(cmd)); },
    preview_agent_mcp: async (cmd) => { await deps.send(await deps.commands.preview(cmd)); },
  };
}
