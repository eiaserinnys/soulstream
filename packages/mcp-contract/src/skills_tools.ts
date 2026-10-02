import { z } from "zod";
import type { McpToolDefinition } from "./tool_definitions.js";
export const skillTools = {
  search_skills: { name: "search_skills", audience: "all", config: {
      description:
        "스킬 카탈로그에서 요청에 맞는 스킬을 적합도 순으로 찾는다. 주입된 카탈로그에 없는 절차성 요청일 때 body_node_id를 얻기 위해 쓴다.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).default(5),
      },
    } },
} as const satisfies Record<string, McpToolDefinition>;
