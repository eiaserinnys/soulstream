import { z } from "zod";
import type { McpToolDefinition } from "./tool_definitions.js";
export const ownedAgentTools = {
  register_existing_mcp_agent: { name: "register_existing_mcp_agent", audience: "internal", config: {
    description: "현재 영속 사용자 신원과 관리자 권한으로 기존 외부 MCP 연결을 중앙 등록한다. 키 원문이나 소유자 이메일은 입력받지 않는다.",
    inputSchema: { name: z.string().trim().min(1).optional(), caller_session_id: z.string().min(1).optional() },
  } },
} as const satisfies Record<string, McpToolDefinition>;
