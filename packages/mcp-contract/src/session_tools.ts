import { z } from "zod";
import type { McpToolDefinition } from "./tool_definitions.js";
const TOOL_TRUNCATE_DEFAULT = 500;

export interface SessionReadPeriod {
  readonly since: string;
  readonly until: string;
}

export type PersistentSessionHistoryInputKind = "human" | "agent" | "system" | "unknown";

export interface PersistentSessionHistorySender {
  readonly display_name: string | null;
  readonly user_id: string | null;
  readonly agent_id: string | null;
  readonly agent_name: string | null;
  readonly agent_node: string | null;
}

export interface PersistentSessionHistoryModelInfo {
  readonly model_preset: string | null;
  readonly backend: string | null;
  readonly model: string | null;
}

interface PersistentSessionHistoryEntryBase {
  readonly event_id: number;
  readonly created_at: string;
  readonly created_at_kst: string;
  readonly text: string;
  readonly text_chars: number;
  readonly truncated: boolean;
  readonly generation: number | null;
}

export type PersistentSessionHistoryEntry =
  | (PersistentSessionHistoryEntryBase & {
      readonly event_type: "user_message" | "intervention_sent";
      readonly kind: PersistentSessionHistoryInputKind;
      readonly input_id: string | null;
      readonly source: string | null;
      readonly sender: PersistentSessionHistorySender;
      readonly purpose: string | null;
      readonly attachment_ids: string[];
      readonly attachments: string[];
      readonly attachment_count: number;
      readonly node_id?: string;
    })
  | (PersistentSessionHistoryEntryBase & {
      readonly event_type: "assistant_message";
      readonly kind: "assistant";
      readonly attachment_ids: string[];
      readonly attachment_count: number;
      readonly attachment_output?: true;
      readonly output_command_id?: string;
      readonly parent_event_id?: string | number;
    })
  | (PersistentSessionHistoryEntryBase & {
      readonly event_type: "session_notification";
      readonly kind: "system";
      readonly source: string | null;
      readonly delivery_id: string | null;
      readonly delivery_intent: string | null;
    })
  | (PersistentSessionHistoryEntryBase & {
      readonly event_type: "generation_started";
      readonly kind: "generation";
      readonly reason: string | null;
      readonly previous: PersistentSessionHistoryModelInfo | null;
      readonly current: PersistentSessionHistoryModelInfo | null;
      readonly context_reset: boolean | null;
    });

export interface PersistentSessionHistoryResult {
  readonly session_id: string;
  readonly display_name: string | null;
  readonly since: string;
  readonly until: string;
  readonly time_zone: "Asia/Seoul";
  readonly entries: PersistentSessionHistoryEntry[];
  readonly returned_count: number;
  readonly next_cursor: number | null;
}

export const sessionTools = {
  list_sessions: { name: "list_sessions", audience: "all", config: {
      description:
        "세션 목록을 페이지네이션하여 조회한다. 경량 필드만 반환 (Python list_sessions 정합).",
      inputSchema: {
        cursor: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        since: z.string().min(1).optional(),
        until: z.string().min(1).optional(),
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
        since: z.string().min(1).optional(),
        until: z.string().min(1).optional(),
      },
    } },
  get_session_event: { name: "get_session_event", audience: "all", config: {
      description: "특정 이벤트의 전문(truncation 없음)을 조회.",
      inputSchema: {
        session_id: z.string(),
        event_id: z.number().int().positive(),
      },
    } },
  list_user_messages: { name: "list_user_messages", audience: "internal", config: {
      description:
        "기간 안의 user_message 이벤트를 여러 세션에 걸쳐 시간순으로 조회한다. "
        + "본문과 발신 정보, 첨부 ID와 저장된 레거시 경로 문자열을 돌려주며, 본문이 없어도 유효한 첨부가 있으면 포함한다. 주입 컨텍스트는 뺀다. "
        + "sources를 생략하면 에이전트와 시스템 발신, 발신 정보가 없는 메시지를 뺀다. "
        + "잘린 본문의 전문은 get_session_event로 본다.",
      inputSchema: {
        since: z.string().min(1).describe("오프셋이 명시된 ISO 8601 시각. 예: 2026-10-05T00:00:00+09:00"),
        until: z.string().min(1).describe("오프셋이 명시된 ISO 8601 시각. 생략하면 호출 시각").optional(),
        sources: z.array(z.string().min(1)).min(1).describe("caller_info.source 값 목록. 주면 이 값의 메시지만 돌려준다").optional(),
        cursor: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(100),
        max_text_chars: z.number().int().min(100).max(20000).default(2000),
      },
    } },
  list_persistent_session_history: { name: "list_persistent_session_history", audience: "internal", strictInputSchema: true, config: {
      title: "List PAS conversation history",
      description:
        "지정한 기간의 영구 세션 대화를 시간순으로 읽는다. 입력과 최종 응답, 알림, 세대 경계를 반환하고 입력의 첨부 ID와 저장된 레거시 경로 문자열도 포함한다. 주입 컨텍스트는 제외한다. "
        + "잘린 본문은 event_id로 get_session_event를 조회해 text 또는 content만 확인한다.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        session_id: z.string().min(1).optional(),
        since: z.string().min(1).describe("오프셋이 명시된 ISO 8601 시작 시각. 포함."),
        until: z.string().min(1).describe("오프셋이 명시된 ISO 8601 끝 시각. 제외."),
        cursor: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        max_text_chars: z.number().int().min(100).max(20000).default(2000),
      },
    } },
  list_turn_usage: { name: "list_turn_usage", audience: "internal", timeoutMs: 30000, strictInputSchema: true, config: {
      title: "List turn usage",
      description:
        "세션 하나 또는 기간의 턴별 사용량을 시간순으로 조회한다. kind는 complete, failed, no_usage이며, 입력 토큰은 캐시를 포함한 합계이고 비용은 정가 추정이다. 기간 전체 합계는 summarize_turn_usage로 본다.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        session_id: z.string().min(1).optional(),
        since: z.string().min(1).describe("오프셋이 명시된 ISO 8601 시작 시각. 포함.").optional(),
        until: z.string().min(1).describe("오프셋이 명시된 ISO 8601 끝 시각. 제외. 생략하면 호출 시각.").optional(),
        cursor: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(100),
      },
    } },
  summarize_turn_usage: { name: "summarize_turn_usage", audience: "internal", timeoutMs: 60000, strictInputSchema: true, config: {
      title: "Summarize turn usage",
      description:
        "기간의 턴 사용량을 한 번에 요약한다. 에이전트와 모델별로 묶으며, 주입 글자 수와 첫 호출 입력 통계는 기간에 만들어진 세션만으로 낸다. 턴별 결과는 list_turn_usage로 본다.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        since: z.string().min(1).describe("오프셋이 명시된 ISO 8601 시작 시각. 포함."),
        until: z.string().min(1).describe("오프셋이 명시된 ISO 8601 끝 시각. 제외. 생략하면 호출 시각.").optional(),
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
        since: z.string().min(1).optional(),
        until: z.string().min(1).optional(),
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
