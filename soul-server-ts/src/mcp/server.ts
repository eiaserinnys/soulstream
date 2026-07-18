/**
 * McpServer factory — Streamable HTTP MCP의 도구 등록 정본.
 *
 * 한 transport(=session)마다 본 함수로 새 McpServer 인스턴스를 생성하여 connect한다.
 * SDK 예제(`simpleStreamableHttp.ts`) 패턴과 동일.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRuntime } from "./runtime.js";
import { createGuardedMcpServer } from "./tool_access.js";
import { registerAgentConfigTools } from "./tools/agent_config.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerClaudeRuntimeTools } from "./tools/claude_runtime.js";
import { registerCustomViewTools } from "./tools/custom_view.js";
import { registerMultiNodeTools } from "./tools/multi_node.js";
import { registerPageTools } from "./tools/page.js";
import { registerReflectTools } from "./tools/reflect.js";
import { registerRunbookTools } from "./tools/runbook.js";
import { registerSessionMgmtTools } from "./tools/session_mgmt.js";
import { registerSessionQueryTools } from "./tools/session_query.js";

export function buildMcpServer(runtime: McpRuntime): McpServer {
  const server = new McpServer({
    name: "soul-server-ts",
    version: "0.0.1",
  });
  const guardedServer = createGuardedMcpServer(server, runtime);
  registerReflectTools(guardedServer, runtime);
  registerSessionQueryTools(guardedServer, runtime);
  registerSessionMgmtTools(guardedServer, runtime);
  registerClaudeRuntimeTools(guardedServer, runtime);
  registerCatalogTools(guardedServer, runtime);
  registerAgentConfigTools(guardedServer, runtime);
  registerMultiNodeTools(guardedServer, runtime);
  registerRunbookTools(guardedServer, runtime);
  registerCustomViewTools(guardedServer, runtime);
  registerPageTools(guardedServer, runtime);
  return server;
}
