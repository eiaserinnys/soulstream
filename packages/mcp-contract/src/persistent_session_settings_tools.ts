import { z } from "zod";
import { PERSISTENT_TURN_USAGE_MODES } from "@soulstream/wire-schema/persistent-session-settings";
import type { McpToolDefinition } from "./tool_definitions.js";

const modelSelection = z.object({
  model_preset: z.string().min(1),
  reasoning_effort: z.string().min(1).nullable().optional(),
  node_id: z.string().min(1).optional(),
}).strict();

const settingFields = {
  default_model: modelSelection.optional(),
  fallback_models: z.array(modelSelection).max(3).optional(),
  show_generation_separator: z.boolean().optional(),
  show_character: z.boolean().optional(),
  show_jev_candidates: z.boolean().optional(),
  turn_usage_mode: z.enum(PERSISTENT_TURN_USAGE_MODES).optional(),
  show_turn_usage: z.boolean().optional(),
  animate_character: z.boolean().optional(),
  show_work_details: z.boolean().optional(),
};

export const persistentSessionSettingsTools = {
  list_persistent_sessions: {
    name: "list_persistent_sessions",
    audience: "internal",
    strictInputSchema: true,
    config: {
      description:
        "영구 세션(PAS) 목록을 이름, 에이전트, 노드, 상태, 마지막 활동 시각과 함께 돌려준다. "
        + "「○○ PAS에 전해라」처럼 PAS를 찾을 때 search_sessions나 list_sessions 대신 이것을 먼저 쓴다. "
        + "PAS는 몇 개뿐이므로 보통 인자 없이 불러 display_name과 agent_name으로 고른다. "
        + "query는 공백으로 나눈 낱말이 모두 이름, 에이전트, 세션 ID 중 어딘가에 들어 있는 항목만 남긴다. "
        + "고른 항목의 session_id 전체를 send_message_to_session의 target_session_id로 넘긴다. "
        + "status가 completed여도 쉬는 중일 뿐이며 메시지를 보내면 깨어난다.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().optional(),
      },
    },
  },
  update_persistent_session_settings: {
    name: "update_persistent_session_settings",
    audience: "internal",
    strictInputSchema: true,
    config: {
      description:
        "영구 세션 설정을 저장한다. 기본 모델을 바꾸면 설정창과 같이 다음 실행에서 새 세대로 바뀐다. "
        + "문맥 초기화와 함께 바꾸려면 이어서 request_session_generation_rollover(reset_context=true)를 부른다. "
        + "fallback_models는 기본 모델 다음의 대체 순위 목록이다(앞이 2순위). 주면 목록 전체를 바꾸고, 빈 배열이면 대체가 없다. "
        + "표시 토글만 바꾸면 세대는 그대로다.",
      inputSchema: {
        session_id: z.string().min(1),
        ...settingFields,
      },
    },
  },
} as const satisfies Record<string, McpToolDefinition>;
