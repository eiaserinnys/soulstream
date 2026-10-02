import { z } from "zod";
import type { McpToolDefinition } from "./tool_definitions.js";
const callerSchema = { caller_session_id: z.string().min(1).optional() };
const jobTargetSchema = {
  node_id: z.string().min(1),
  agent_id: z.string().min(1),
  model_preset: z.string().min(1).nullable(),
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
      description: "반복 또는 1회 에이전트 작업을 생성한다. 반복은 schedule_expressions(cron 배열), 1회는 run_at(오프셋 포함 ISO 8601, 예: 2026-09-29T09:00:00+09:00) 중 정확히 하나를 준다. 1회 작업은 실행으로 세션이 만들어진 것이 확인되면 작업과 이력이 삭제된다. idempotency_key는 재시도에도 같은 값을 쓴다.",
      inputSchema: {
        name: z.string().min(1),
        prompt: z.string().min(1),
        idempotency_key: z.string().min(1),
        enabled: z.boolean().optional(),
        late_run_window_seconds: z.number().int().positive().optional(),
        ...createScheduleSchema,
        ...jobTargetSchema,
        ...callerSchema,
      },
    } },
  update_recurring_job: { name: "update_recurring_job", audience: "internal", config: {
      description: "반복 작업을 CAS version으로 수정하거나 일시정지·재개한다. 1회 작업의 실행 시각은 run_at으로 바꾼다.",
      inputSchema: {
        job_id: z.string().min(1),
        expected_version: z.number().int().positive(),
        name: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        timezone: z.string().min(1).optional(),
        schedule_expressions: z.array(z.string().min(1)).min(1).optional(),
        run_at: z.string().min(1).describe("오프셋이 명시된 ISO 8601 시각. 예: 2026-09-29T09:00:00+09:00").optional(),
        node_id: z.string().min(1).optional(),
        agent_id: z.string().min(1).optional(),
        model_preset: z.string().min(1).nullable().optional(),
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
