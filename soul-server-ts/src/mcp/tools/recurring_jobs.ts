import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { RecurringJobHostClient } from "../../recurring-jobs/recurring_job_host_client.js";
import { isCurrentMcpCallerExternal } from "../request_context.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { resolveMcpCallerAttribution } from "./caller_session.js";

const containerSchema = z.object({
  kind: z.enum(["folder", "task"]),
  id: z.string().min(1),
});
const callerSchema = { caller_session_id: z.string().min(1).optional() };
const jobTargetSchema = {
  node_id: z.string().min(1),
  agent_id: z.string().min(1),
  model_preset: z.string().min(1).nullable(),
  container: containerSchema,
  folder_id: z.string().min(1),
};
const scheduleSchema = {
  timezone: z.string().min(1),
  schedule_expressions: z.array(z.string().min(1)).min(1),
};

type RecurringJobMcpActor = {
  readonly ownerEmail: string;
  readonly actorId: string;
  readonly callerInfo: Record<string, unknown>;
  readonly source: "agent";
};

export function registerRecurringJobTools(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "list_recurring_jobs",
    {
      description: "현재 신뢰된 Soulstream 호출자의 반복 작업 목록을 조회한다.",
      inputSchema: { include_archived: z.boolean().optional(), ...callerSchema },
    },
    async ({ include_archived, caller_session_id }) => await call(runtime, caller_session_id, "list", {
      include_archived: include_archived ?? false,
    }),
  );

  server.registerTool(
    "get_recurring_job",
    {
      description: "반복 작업 한 건과 서버가 계산한 다음 실행 정보를 조회한다.",
      inputSchema: { job_id: z.string().min(1), include_archived: z.boolean().optional(), ...callerSchema },
    },
    async ({ job_id, include_archived, caller_session_id }) => await call(runtime, caller_session_id, "get", {
      job_id,
      include_archived: include_archived ?? false,
    }),
  );

  server.registerTool(
    "preview_recurring_schedule",
    {
      description: "timezone과 cron 배열의 다음 5회 실행 시각을 서버 규칙으로 미리 본다.",
      inputSchema: { ...scheduleSchema, ...callerSchema },
    },
    async ({ timezone, schedule_expressions, caller_session_id }) => await call(runtime, caller_session_id, "preview", {
      timezone,
      schedule_expressions,
    }),
  );

  server.registerTool(
    "create_recurring_job",
    {
      description: "반복 에이전트 작업을 생성한다. idempotency_key는 재시도에도 같은 값을 쓴다.",
      inputSchema: {
        name: z.string().min(1),
        prompt: z.string().min(1),
        idempotency_key: z.string().min(1),
        enabled: z.boolean().optional(),
        late_run_window_seconds: z.number().int().positive().optional(),
        ...scheduleSchema,
        ...jobTargetSchema,
        ...callerSchema,
      },
    },
    async (input) => await call(runtime, input.caller_session_id, "create", {
      name: input.name,
      prompt: input.prompt,
      idempotency_key: input.idempotency_key,
      timezone: input.timezone,
      schedule_expressions: input.schedule_expressions,
      node_id: input.node_id,
      agent_id: input.agent_id,
      model_preset: input.model_preset,
      container: input.container,
      folder_id: input.folder_id,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.late_run_window_seconds === undefined
        ? {}
        : { late_run_window_seconds: input.late_run_window_seconds }),
    }),
  );

  server.registerTool(
    "update_recurring_job",
    {
      description: "반복 작업을 CAS version으로 수정하거나 일시정지·재개한다.",
      inputSchema: {
        job_id: z.string().min(1),
        expected_version: z.number().int().positive(),
        name: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        timezone: z.string().min(1).optional(),
        schedule_expressions: z.array(z.string().min(1)).min(1).optional(),
        node_id: z.string().min(1).optional(),
        agent_id: z.string().min(1).optional(),
        model_preset: z.string().min(1).nullable().optional(),
        container: containerSchema.optional(),
        folder_id: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        late_run_window_seconds: z.number().int().positive().optional(),
        ...callerSchema,
      },
    },
    async ({ caller_session_id, ...input }) => await call(runtime, caller_session_id, "update", input),
  );

  server.registerTool(
    "run_recurring_job",
    {
      description: "반복 작업을 지금 한 번 실행한다. pause 상태에서도 수동 실행은 허용된다.",
      inputSchema: { job_id: z.string().min(1), idempotency_key: z.string().min(1), ...callerSchema },
    },
    async ({ job_id, idempotency_key, caller_session_id }) => await call(runtime, caller_session_id, "run", {
      job_id,
      idempotency_key,
    }),
  );

  server.registerTool(
    "archive_recurring_job",
    {
      description: "반복 작업을 보관한다. 이미 실행 중인 세션은 종료하지 않는다.",
      inputSchema: { job_id: z.string().min(1), expected_version: z.number().int().positive(), ...callerSchema },
    },
    async ({ job_id, expected_version, caller_session_id }) => await call(runtime, caller_session_id, "archive", {
      job_id,
      expected_version,
    }),
  );

  server.registerTool(
    "list_recurring_job_runs",
    {
      description: "반복 작업의 실행 이력과 연결된 Soulstream session_id를 조회한다.",
      inputSchema: { job_id: z.string().min(1), limit: z.number().int().positive().max(100).optional(), ...callerSchema },
    },
    async ({ job_id, limit, caller_session_id }) => await call(runtime, caller_session_id, "list_runs", {
      job_id,
      ...(limit === undefined ? {} : { limit }),
    }),
  );
}

/** External/LLM is a trust boundary, not a synonym for missing identity. */
export function resolveMcpRecurringJobActor(
  runtime: McpRuntime,
  callerSessionId: string | null | undefined,
): { ok: true; actor: RecurringJobMcpActor } | { ok: false; error: string } {
  if (isCurrentMcpCallerExternal()) {
    return { ok: false, error: "Recurring-job tools are not available to untrusted external or LLM callers." };
  }
  const attribution = resolveMcpCallerAttribution(runtime, callerSessionId);
  const email = attribution.callerInfo?.email;
  if (!attribution.callerSessionId) {
    return { ok: false, error: "A trusted Soulstream caller session is required for recurring-job tools." };
  }
  if (typeof email !== "string" || !email.trim()) {
    return { ok: false, error: "The trusted caller session has no verified owner email for recurring-job access." };
  }
  return {
    ok: true,
    actor: {
      ownerEmail: email,
      actorId: attribution.callerSessionId,
      callerInfo: attribution.callerInfo as Record<string, unknown>,
      source: "agent",
    },
  };
}

async function call(
  runtime: McpRuntime,
  callerSessionId: string | null | undefined,
  operation: string,
  body: Record<string, unknown>,
) {
  const resolved = resolveMcpRecurringJobActor(runtime, callerSessionId);
  if (!resolved.ok) return errorResult(resolved.error);
  if (!runtime.orch) return errorResult("recurring jobs are not configured with an orchestrator");
  try {
    const client = new RecurringJobHostClient({ orch: runtime.orch, logger: runtime.logger });
    return jsonResult(await client.request(operation, { actor: resolved.actor, ...body }));
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}
