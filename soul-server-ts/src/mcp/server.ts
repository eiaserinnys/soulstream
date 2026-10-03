/**
 * McpServer factory — Streamable HTTP MCP의 도구 등록 정본.
 *
 * 한 transport(=session)마다 본 함수로 새 McpServer 인스턴스를 생성하여 connect한다.
 * SDK 예제(`simpleStreamableHttp.ts`) 패턴과 동일.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRuntime } from "./runtime.js";
import { createInventoryMcpServer } from "./tool_access.js";
import { registerAgentConfigTools } from "./tools/agent_config.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerClaudeRuntimeTools } from "./tools/claude_runtime.js";
import { registerCustomViewTools } from "./tools/custom_view.js";
import { registerMultiNodeTools } from "./tools/multi_node.js";
import { registerPageTools } from "./tools/page.js";
import { registerCardOrchestrationTools } from "./tools/card_orchestration.js";
import { registerRecurringJobTools } from "./tools/recurring_jobs.js";
import { registerReflectTools } from "./tools/reflect.js";
import { registerLiveCardView } from "./tools/live_card_view.js";
import { registerFolderTools } from "./tools/folder.js";
import { registerSessionMgmtTools } from "./tools/session_mgmt.js";
import { registerSessionQueryTools } from "./tools/session_query.js";
import { registerSkillsTools } from "./tools/skills.js";
import { registerWorktreeTools } from "./tools/worktree.js";
import { registerExternalLlmTools } from "./tools/external_llm.js";

export function buildMcpServer(runtime: McpRuntime): McpServer {
  const server = new McpServer({
    name: "soul-server-ts",
    version: "0.0.1",
  });
  const inventoryServer = createInventoryMcpServer(server, runtime);
  registerReflectTools(inventoryServer, runtime);
  registerSessionQueryTools(inventoryServer, runtime);
  registerSessionMgmtTools(inventoryServer, runtime);
  registerClaudeRuntimeTools(inventoryServer, runtime);
  registerCatalogTools(inventoryServer, runtime);
  registerSkillsTools(inventoryServer, runtime);
  registerAgentConfigTools(inventoryServer, runtime);
  registerMultiNodeTools(inventoryServer, runtime);
  registerFolderTools(inventoryServer, runtime);
  registerLiveCardView(inventoryServer, runtime);
  registerCustomViewTools(inventoryServer, runtime);
  registerPageTools(inventoryServer, runtime);
  registerWorktreeTools(inventoryServer, runtime);
  registerRecurringJobTools(inventoryServer, runtime);
  registerCardOrchestrationTools(inventoryServer, runtime);
  registerExternalLlmTools(inventoryServer, runtime);
  return server;
}
