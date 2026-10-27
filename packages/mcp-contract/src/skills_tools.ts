import { z } from "zod";
import type { McpToolDefinition } from "./tool_definitions.js";
export const skillTools = {
  search_skills: { name: "search_skills", audience: "all", timeoutMs: 190000, config: {
      description:
        "스킬 카탈로그에서 요청에 맞는 스킬을 적합도 순으로 찾는다. 주입된 카탈로그에 없는 절차성 요청일 때 body_node_id를 얻기 위해 쓴다.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).default(5),
      },
    } },
  match_skill_catalogs: {
    name: "match_skill_catalogs",
    audience: "internal",
    timeoutMs: 190000,
    config: {
      description:
        "스킬의 1차 활동 태그(medium, operations, accepts_input) 가산점과 Jev 전체 카탈로그 의미 평가를 결합해 현재 요청에 필요한 직교/번들 도메인 카탈로그와 오버레이 바인딩을 찾는다.",
      inputSchema: {
        intent: z.string().min(1),
        skill_name: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(10).default(5),
      },
    },
  },
  load_skill: {
    name: "load_skill",
    audience: "all",
    timeoutMs: 170000,
    config: {
      description:
        "스킬 본문을 읽고 link 블록의 call, include, pick을 해석해 펼친 본문과 출처, 선택 기록을 돌려준다.",
      inputSchema: {
        name: z.string().min(1),
        intent: z.string().min(1).optional(),
        pins: z.array(z.string().min(1)).optional(),
      },
    },
  },
} as const satisfies Record<string, McpToolDefinition>;
