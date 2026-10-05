import { z } from "zod";
import type { McpToolDefinition } from "./tool_definitions.js";
const TOOL_TRUNCATE_DEFAULT = 500;

export const sessionTools = {
  list_sessions: { name: "list_sessions", audience: "all", config: {
      description:
        "세션 목록을 페이지네이션하여 조회한다. 경량 필드만 반환 (Python list_sessions 정합).",
      inputSchema: {
        cursor: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        search: z.string().optional(),
        folder_id: z.string().optional(),
        folder_name: z.string().optional(),
        node_id: z.string().optional(),
        node_name: z.string().optional(),
      },
    } },
  list_session_events: { name: "list_session_events", audience: "all", config: {
      description:
        "세션 이벤트 목록 페이지네이션. tool_content로 tool_use/tool_result 길이 제어 (Python 정합).",
      inputSchema: {
        session_id: z.string(),
        cursor: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        tool_truncate_chars: z
          .number()
          .int()
          .min(0)
          .default(TOOL_TRUNCATE_DEFAULT),
        event_types: z.array(z.string()).optional(),
        tool_content: z
          .enum(["truncate", "full", "omit"])
          .default("truncate"),
      },
    } },
  get_session_event: { name: "get_session_event", audience: "all", config: {
      description: "특정 이벤트의 전문(truncation 없음)을 조회.",
      inputSchema: {
        session_id: z.string(),
        event_id: z.number().int().positive(),
      },
    } },
  get_session_story: { name: "get_session_story", audience: "all", config: {
      description:
        "접힌 세션 줄거리와 아직 접히지 않은 턴 요약을 조회한다. 스토리가 없으면 저장된 턴 요약으로 폴백한다.",
      inputSchema: {
        session_id: z.string(),
        include_highlight: z.boolean().default(false),
      },
    } },
  get_session_highlight: { name: "get_session_highlight", audience: "all", config: {
      description:
        "저장된 세션 하이라이트를 우선 조회하고, 스토리가 없으면 저장된 턴 요약으로 폴백한다.",
      inputSchema: {
        session_id: z.string(),
      },
    } },
  search_session_history: { name: "search_session_history", audience: "all", config: {
      description:
        "이벤트 텍스트 검색 (BM25, Python SessionSearchEngine 정합). "
        + '툴 사용 기록은 event_types: ["tool_start","tool_result"]를 명시해 검색한다. '
        + "세션 단위로 찾을 때는 search_sessions를 먼저 쓴다. "
        + "호출한 세션 자신의 이벤트는 session_ids에 직접 넣지 않는 한 결과에서 뺀다.",
      inputSchema: {
        query: z.string().min(1),
        session_ids: z.array(z.string()).optional(),
        event_types: z.array(z.string()).optional(),
        search_session_id: z.boolean().default(false),
        include_turn_summaries: z.boolean().default(false),
        include_highlight: z.boolean().default(false),
        include_story: z.boolean().default(false),
        top_k: z.number().int().min(1).max(100).default(10),
      },
    } },
  get_session_summary: { name: "get_session_summary", audience: "all", config: {
      description: "세션의 턴별 요약 (LLM 미사용, DB 이벤트 순회).",
      inputSchema: {
        session_id: z.string(),
        max_response_chars: z.number().int().min(0).default(500),
      },
    } },
  get_session_turn_summaries: { name: "get_session_turn_summaries", audience: "all", config: {
      description:
        "세션 턴 요약을 개수(count), 단건(index), 범위(range) 모드로 조회한다.",
      inputSchema: {
        session_id: z.string(),
        mode: z.enum(["count", "index", "range"]),
        turn_number: z.number().int().positive().optional(),
        from_turn_number: z.number().int().positive().optional(),
        to_turn_number: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
    } },
  expand_session_turn: { name: "expand_session_turn", audience: "all", config: {
      description:
        "턴 번호로 턴의 요약과 원문 이벤트를 조회한다. 기본 원문에는 사용자 입력과 응답만 포함한다.",
      inputSchema: {
        session_id: z.string().optional(),
        turn: z.union([
          z.number().int().positive(),
          z.string().regex(/^T[1-9][0-9]*$/),
        ]),
        to_turn: z.union([
          z.number().int().positive(),
          z.string().regex(/^T[1-9][0-9]*$/),
        ]).optional(),
        include_tools: z.boolean().default(false),
        max_chars: z.number().int().min(1000).max(60000).default(20000),
      },
    } },
  search_sessions: { name: "search_sessions", audience: "all", timeoutMs: 15000, config: {
      description:
        "과거 세션을 뜻으로 찾는다. 검색어가 가리키는 작업이나 대화를 한 세션을 관련도 순으로 돌려준다. "
        + "원문 이벤트 조각(특정 문장, 도구 출력)이 필요하면 search_session_history를 쓴다.",
      inputSchema: {
        query: z.string().min(1).max(500),
        top_k: z.number().int().min(1).max(30).default(10),
        folder_id: z.string().optional(),
      },
    } },
  get_session_name: { name: "get_session_name", audience: "all", config: {
      description: "세션 표시 이름 조회.",
      inputSchema: { session_id: z.string() },
    } },
  set_session_name: { name: "set_session_name", audience: "all", config: {
      description:
        "세션 표시 이름 설정. 빈 문자열 → 제거. CatalogService 경유로 broadcastCatalog 자동.",
      inputSchema: {
        session_id: z.string(),
        name: z.string().default(""),
      },
    } },
  delete_session: { name: "delete_session", audience: "internal", config: {
      description: "세션 삭제 (이벤트 cascade 포함).",
      inputSchema: { session_id: z.string() },
    } },
} as const satisfies Record<string, McpToolDefinition>;
