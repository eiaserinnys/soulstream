import { z } from "zod";
import type { McpToolDefinition } from "./tool_definitions.js";
const callerSchema = { caller_session_id: z.string().min(1).optional() };
const modelPresetFallbacks = z.array(z.string().min(1).refine(item => item.trim().length > 0)).optional().describe(
  "만들 때와 실행 중 한도에서 차례로 쓸 대체 모델 preset id. 같은 노드 안에서만 쓴다",
);
const jobTargetSchema = {
  node_id: z.string().min(1),
  agent_id: z.string().min(1),
  model_preset: z.string().min(1).nullable(),
  model_preset_fallbacks: modelPresetFallbacks,
  folder_id: z.string().min(1),
};
const scheduleSchema = {
  timezone: z.string().min(1),
  schedule_expressions: z.array(z.string().min(1)).min(1),
};
const createScheduleSchema = {
  timezone: z.string().min(1),
  schedule_expressions: z.array(z.string().min(1)).min(1).optional(),
  run_at: z.string().min(1).describe("오프셋이 명시된 ISO 8601 시각. 예: 2026-09-29T09:00:00+09:00").optional(),
};
const eventTriggerSchema = z.object({
  type: z.literal("node_connected"),
  node_id: z.string().min(1).describe("트리거 노드. 생략하면 실행 노드(node_id)를 쓴다.").optional(),
  settle_seconds: z.number().int().min(0).max(3600).optional(),
  cooldown_seconds: z.number().int().min(0).max(604800).optional(),
  repeat: z.boolean().optional(),
}).describe("노드 접속 시 깨어나는 조건. type은 node_connected만 지원한다.");


export const recurringJobTools = {
  list_recurring_jobs: { name: "list_recurring_jobs", audience: "internal", config: {
      description: "현재 신뢰된 Soulstream 호출자의 반복 작업 목록을 조회한다.",
      inputSchema: { include_archived: z.boolean().optional(), ...callerSchema },
    } },
  get_recurring_job: { name: "get_recurring_job", audience: "internal", config: {
      description: "반복 작업 한 건과 서버가 계산한 다음 실행 정보를 조회한다.",
      inputSchema: { job_id: z.string().min(1), include_archived: z.boolean().optional(), ...callerSchema },
    } },
  preview_recurring_schedule: { name: "preview_recurring_schedule", audience: "internal", config: {
      description: "timezone과 cron 배열의 다음 5회 실행 시각을 서버 규칙으로 미리 본다.",
      inputSchema: { ...scheduleSchema, ...callerSchema },
    } },
  create_recurring_job: { name: "create_recurring_job", audience: "internal", config: {
      description: "반복 또는 1회 에이전트 작업을 생성한다. 반복은 schedule_expressions(cron 배열), 1회는 run_at(오프셋 포함 ISO 8601, 예: 2026-09-29T09:00:00+09:00), event_trigger(트리거 노드가 붙으면 실행) 가운데 정확히 하나를 준다. 1회 작업과 repeat=false event 작업은 실행으로 세션이 만들어진 것이 확인되면 작업과 이력이 삭제된다. idempotency_key는 재시도에도 같은 값을 쓴다.",
      inputSchema: {
        name: z.string().min(1),
        prompt: z.string().min(1),
        idempotency_key: z.string().min(1),
        enabled: z.boolean().optional(),
        late_run_window_seconds: z.number().int().positive().optional(),
        ...createScheduleSchema,
        event_trigger: eventTriggerSchema.optional(),
        ...jobTargetSchema,
        ...callerSchema,
      },
    } },
  update_recurring_job: { name: "update_recurring_job", audience: "internal", config: {
      description: "반복 작업을 CAS version으로 수정하거나 일시정지·재개한다. 1회 작업의 실행 시각은 run_at으로, event 작업의 조건은 event_trigger로 통째로 바꾼다. 작업 종류를 바꾸는 수정은 거부한다.",
      inputSchema: {
        job_id: z.string().min(1),
        expected_version: z.number().int().positive(),
        name: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        timezone: z.string().min(1).optional(),
        schedule_expressions: z.array(z.string().min(1)).min(1).optional(),
        run_at: z.string().min(1).describe("오프셋이 명시된 ISO 8601 시각. 예: 2026-09-29T09:00:00+09:00").optional(),
        event_trigger: eventTriggerSchema.optional(),
        node_id: z.string().min(1).optional(),
        agent_id: z.string().min(1).optional(),
        model_preset: z.string().min(1).nullable().optional(),
        model_preset_fallbacks: modelPresetFallbacks,
        folder_id: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        late_run_window_seconds: z.number().int().positive().optional(),
        ...callerSchema,
      },
    } },
  run_recurring_job: { name: "run_recurring_job", audience: "internal", config: {
      description: "반복 작업을 지금 한 번 실행한다. pause 상태에서도 수동 실행은 허용된다.",
      inputSchema: { job_id: z.string().min(1), idempotency_key: z.string().min(1), ...callerSchema },
    } },
  archive_recurring_job: { name: "archive_recurring_job", audience: "internal", config: {
      description: "반복 작업을 보관한다. 이미 실행 중인 세션은 종료하지 않는다.",
      inputSchema: { job_id: z.string().min(1), expected_version: z.number().int().positive(), ...callerSchema },
    } },
  list_recurring_job_runs: { name: "list_recurring_job_runs", audience: "internal", config: {
      description: "반복 작업의 실행 이력과 연결된 Soulstream session_id를 조회한다.",
      inputSchema: { job_id: z.string().min(1), limit: z.number().int().positive().max(100).optional(), ...callerSchema },
    } },
} as const satisfies Record<string, McpToolDefinition>;
