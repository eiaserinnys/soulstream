import { z } from "zod";
import { PERSISTENT_TURN_USAGE_MODES } from "@soulstream/wire-schema/persistent-session-settings";
import type { McpToolDefinition } from "./tool_definitions.js";

const modelSelection = z.object({
  model_preset: z.string().min(1),
  reasoning_effort: z.string().min(1).nullable().optional(),
}).strict();

const settingFields = {
  default_model: modelSelection.optional(),
  fallback_model: modelSelection.nullable().optional(),
  show_generation_separator: z.boolean().optional(),
  show_character: z.boolean().optional(),
  show_jev_candidates: z.boolean().optional(),
  turn_usage_mode: z.enum(PERSISTENT_TURN_USAGE_MODES).optional(),
  show_turn_usage: z.boolean().optional(),
  animate_character: z.boolean().optional(),
};

export const persistentSessionSettingsTools = {
  update_persistent_session_settings: {
    name: "update_persistent_session_settings",
    audience: "internal",
    strictInputSchema: true,
    config: {
      description:
        "영구 세션 설정을 저장한다. 기본 모델을 바꾸면 설정창과 같이 다음 실행에서 새 세대로 바뀐다. "
        + "문맥 초기화와 함께 바꾸려면 이어서 request_session_generation_rollover(reset_context=true)를 부른다. "
        + "표시 토글만 바꾸면 세대는 그대로다.",
      inputSchema: {
        session_id: z.string().min(1),
        ...settingFields,
      },
    },
  },
} as const satisfies Record<string, McpToolDefinition>;
