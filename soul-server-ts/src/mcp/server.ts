/**
 * McpServer factory — Streamable HTTP MCP의 도구 등록 정본.
 *
 * 한 transport(=session)마다 본 함수로 새 McpServer 인스턴스를 생성하여 connect한다.
 * SDK 예제(`simpleStreamableHttp.ts`) 패턴과 동일.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRuntime } from "./runtime.js";
import { registerAgentConfigTools } from "./tools/agent_config.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerClaudeRuntimeTools } from "./tools/claude_runtime.js";
import { registerMultiNodeTools } from "./tools/multi_node.js";
import { registerReflectTools } from "./tools/reflect.js";
import { registerSessionMgmtTools } from "./tools/session_mgmt.js";
import { registerSessionQueryTools } from "./tools/session_query.js";
import { registerTaskTreeTools } from "./tools/task_tree.js";

export function buildMcpServer(runtime: McpRuntime): McpServer {
  const server = new McpServer({
    name: "soul-server-ts",
    version: "0.0.1",
  });
  registerReflectTools(server, runtime);
  registerSessionQueryTools(server, runtime);
  registerSessionMgmtTools(server, runtime);
  registerClaudeRuntimeTools(server, runtime);
  registerCatalogTools(server, runtime);
  registerAgentConfigTools(server, runtime);
  registerMultiNodeTools(server, runtime);
  registerTaskTreeTools(server, runtime);
  return server;
}
