import { z } from "zod";
import { PERSISTENT_FALLBACK_MODELS_MAX } from "@soulstream/wire-schema/persistent-session-settings";
import type { McpToolDefinition } from "./tool_definitions.js";

const valueSchema = z.object({
  model_preset: z.string().min(1),
  fallback_models: z.array(z.object({ model_preset: z.string().min(1), reasoning_effort: z.string().min(1).nullable() }).strict()).max(PERSISTENT_FALLBACK_MODELS_MAX),
}).strict();
export const persistentDefaultsTools = {
  get_persistent_session_defaults: { name: "get_persistent_session_defaults", audience: "internal", config: {
    description: "새 영구 세션의 전역 기본 모델과 대체 순서 및 설정 버전을 조회한다.",
    inputSchema: {},
  } },
  update_persistent_session_defaults: { name: "update_persistent_session_defaults", audience: "internal", config: {
    description: "새 영구 세션의 전역 기본 모델과 대체 순서를 조회한 버전으로 저장한다.",
    inputSchema: { value: valueSchema, expectedVersion: z.number().int().nonnegative() },
  } },
} as const satisfies Record<string, McpToolDefinition>;
