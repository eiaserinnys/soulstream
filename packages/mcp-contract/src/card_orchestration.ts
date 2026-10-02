import { z } from "zod";
import type { McpToolDefinition } from "./tool_definitions.js";
const policySchema = z
  .object({
    enabled: z.boolean(),
    candidates: z.array(
      z
        .object({
          agentId: z.string().min(1),
          nodeId: z.string().min(1),
          modelPreset: z.string().min(1),
          minimumRemainingPercent: z.number().min(0).max(100),
        })
        .strict(),
    ),
    usageMaxAgeMs: z.literal(300000),
    sessionFolderId: z.uuid().nullable(),
    systemFolderParentId: z.uuid().nullable(),
  })
  .strict();

export const cardOrchestrationTools = {
  get_card_orchestration_settings: { name: "get_card_orchestration_settings", audience: "internal", config: {
      description:
        "관리자 전용 중앙 카드 배정 정책과 최근 판단 상태를 조회한다. 판단 세션은 사용할 수 없다.",
      inputSchema: { caller_session_id: z.string().min(1).optional() },
    } },
  update_card_orchestration_settings: { name: "update_card_orchestration_settings", audience: "internal", config: {
      description:
        "관리자 전용 중앙 카드 배정 정책을 CAS version으로 저장한다. 후보 배열 순서가 모델 우선순위이며 사용량은 원천 관측 5분 이내여야 한다. 저장 폴더 null은 첫 판단 직전 서버가 생성한다. 기존 설정 version을 먼저 조회한다.",
      inputSchema: {
        caller_session_id: z.string().min(1).optional(),
        expectedVersion: z.number().int().positive(),
        policy: policySchema,
      },
    } },
} as const satisfies Record<string, McpToolDefinition>;
