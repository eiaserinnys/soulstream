import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { RecurringJobError, type RecurringJobActor, type RecurringJobContainer, type RecurringJobCreateInput, type RecurringJobUpdateInput } from "./types.js";
import { RecurringJobService } from "./service.js";

export type RecurringJobRouteActorResolver = (
  request: FastifyRequest,
) => Promise<RecurringJobActor | null | undefined> | RecurringJobActor | null | undefined;

export type RecurringJobRouteOptions = {
  readonly service: RecurringJobService;
  readonly resolveActor: RecurringJobRouteActorResolver;
};

export const recurringJobRouteAuthRequirements = {
  "GET /api/recurring-jobs": true,
  "POST /api/recurring-jobs": true,
  "POST /api/recurring-jobs/preview": true,
  "GET /api/recurring-jobs/{job_id}": true,
  "PATCH /api/recurring-jobs/{job_id}": true,
  "POST /api/recurring-jobs/{job_id}/run": true,
  "POST /api/recurring-jobs/{job_id}/archive": true,
  "GET /api/recurring-jobs/{job_id}/runs": true,
} as const;

export function registerRecurringJobRoutes(
  app: FastifyInstance,
  options: RecurringJobRouteOptions,
): void {
  app.get("/api/recurring-jobs", async (request, reply) => {
    const actor = await requireActor(options, request, reply);
    if (!actor) return;
    try {
      return reply.send({ jobs: (await options.service.list(actor, booleanQuery(request, "include_archived"))).map(serializeJob) });
    } catch (error) {
      return recurringJobError(reply, error);
    }
  });

  app.post("/api/recurring-jobs/preview", async (request, reply) => {
    const actor = await requireActor(options, request, reply);
    if (!actor) return;
    const body = objectBody(request.body, reply);
    if (!body) return;
    try {
      return reply.send(options.service.preview({
        timezone: stringValue(body, "timezone"),
        scheduleExpressions: stringsValue(body, "scheduleExpressions", "schedule_expressions"),
      }));
    } catch (error) {
      return recurringJobError(reply, error);
    }
  });

  app.post("/api/recurring-jobs", async (request, reply) => {
    const actor = await requireActor(options, request, reply);
    if (!actor) return;
    const body = objectBody(request.body, reply);
    if (!body) return;
    try {
      const job = await options.service.create(actor, createInput(body));
      return reply.code(201).send({ job: serializeJob(job) });
    } catch (error) {
      return recurringJobError(reply, error);
    }
  });

  app.get<{ Params: { job_id: string } }>("/api/recurring-jobs/:job_id", async (request, reply) => {
    const actor = await requireActor(options, request, reply);
    if (!actor) return;
    try {
      return reply.send({ job: serializeJob(await options.service.get(actor, request.params.job_id, booleanQuery(request, "include_archived"))) });
    } catch (error) {
      return recurringJobError(reply, error);
    }
  });

  app.patch<{ Params: { job_id: string } }>("/api/recurring-jobs/:job_id", async (request, reply) => {
    const actor = await requireActor(options, request, reply);
    if (!actor) return;
    const body = objectBody(request.body, reply);
    if (!body) return;
    try {
      return reply.send({ job: serializeJob(await options.service.update(actor, request.params.job_id, updateInput(body))) });
    } catch (error) {
      return recurringJobError(reply, error);
    }
  });

  app.post<{ Params: { job_id: string } }>("/api/recurring-jobs/:job_id/run", async (request, reply) => {
    const actor = await requireActor(options, request, reply);
    if (!actor) return;
    const body = objectBody(request.body, reply);
    if (!body) return;
    try {
      return reply.code(201).send({ run: serializeRun(await options.service.runManual(
        actor,
        request.params.job_id,
        stringAlias(body, "idempotencyKey", "idempotency_key"),
      )) });
    } catch (error) {
      return recurringJobError(reply, error);
    }
  });

  app.post<{ Params: { job_id: string } }>("/api/recurring-jobs/:job_id/archive", async (request, reply) => {
    const actor = await requireActor(options, request, reply);
    if (!actor) return;
    const body = objectBody(request.body, reply);
    if (!body) return;
    try {
      return reply.send({ job: serializeJob(await options.service.archive(
        actor,
        request.params.job_id,
        integerAlias(body, "expectedVersion", "expected_version"),
      )) });
    } catch (error) {
      return recurringJobError(reply, error);
    }
  });

  app.get<{ Params: { job_id: string } }>("/api/recurring-jobs/:job_id/runs", async (request, reply) => {
    const actor = await requireActor(options, request, reply);
    if (!actor) return;
    try {
      return reply.send({ runs: (await options.service.listRuns(
        actor,
        request.params.job_id,
        numberQuery(request, "limit") ?? 50,
      )).map(serializeRun) });
    } catch (error) {
      return recurringJobError(reply, error);
    }
  });
}

export function createInput(body: Record<string, unknown>): RecurringJobCreateInput {
  return {
    idempotencyKey: stringAlias(body, "idempotencyKey", "idempotency_key"),
    name: stringValue(body, "name"),
    prompt: stringValue(body, "prompt"),
    timezone: stringValue(body, "timezone"),
    scheduleExpressions: stringsValue(body, "scheduleExpressions", "schedule_expressions"),
    nodeId: stringAlias(body, "nodeId", "node_id"),
    agentId: stringAlias(body, "agentId", "agent_id"),
    modelPreset: nullableStringAlias(body, "modelPreset", "model_preset"),
    container: containerValue(body),
    folderId: stringAlias(body, "folderId", "folder_id"),
    ...(body.lateRunWindowSeconds === undefined && body.late_run_window_seconds === undefined
      ? {}
      : { lateRunWindowSeconds: integerAlias(body, "lateRunWindowSeconds", "late_run_window_seconds") }),
    ...(has(body, "enabled") ? { enabled: booleanValue(body, "enabled") } : {}),
  };
}

export function updateInput(body: Record<string, unknown>): RecurringJobUpdateInput {
  const result: { -readonly [Key in keyof RecurringJobUpdateInput]: RecurringJobUpdateInput[Key] } = {
    expectedVersion: integerAlias(body, "expectedVersion", "expected_version"),
  };
  if (has(body, "name")) result.name = stringValue(body, "name");
  if (has(body, "prompt")) result.prompt = stringValue(body, "prompt");
  if (has(body, "timezone")) result.timezone = stringValue(body, "timezone");
  if (has(body, "scheduleExpressions") || has(body, "schedule_expressions")) {
    result.scheduleExpressions = stringsValue(body, "scheduleExpressions", "schedule_expressions");
  }
  if (has(body, "nodeId") || has(body, "node_id")) result.nodeId = stringAlias(body, "nodeId", "node_id");
  if (has(body, "agentId") || has(body, "agent_id")) result.agentId = stringAlias(body, "agentId", "agent_id");
  if (has(body, "modelPreset") || has(body, "model_preset")) {
    result.modelPreset = nullableStringAlias(body, "modelPreset", "model_preset");
  }
  if (has(body, "container")) result.container = containerValue(body);
  if (has(body, "folderId") || has(body, "folder_id")) result.folderId = stringAlias(body, "folderId", "folder_id");
  if (has(body, "enabled")) {
    if (typeof body.enabled !== "boolean") throw new RecurringJobError("VALIDATION", "enabled must be boolean", 422);
    result.enabled = body.enabled;
  }
  if (has(body, "lateRunWindowSeconds") || has(body, "late_run_window_seconds")) {
    result.lateRunWindowSeconds = integerAlias(body, "lateRunWindowSeconds", "late_run_window_seconds");
  }
  return result;
}

export function serializeJob(job: import("./types.js").RecurringJob): Record<string, unknown> {
  return {
    job_id: job.jobId,
    owner_email: job.ownerEmail,
    name: job.name,
    prompt: job.prompt,
    timezone: job.timezone,
    schedule_expressions: job.scheduleExpressions,
    schedule: { timezone: job.timezone, schedule_expressions: job.scheduleExpressions },
    node_id: job.nodeId,
    agent_id: job.agentId,
    model_preset: job.modelPreset,
    container: job.container,
    folder_id: job.folderId,
    enabled: job.enabled,
    archived_at: job.archivedAt,
    late_run_window_seconds: job.lateRunWindowSeconds,
    next_run_at: job.nextRunAt,
    version: job.version,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

export function serializeRun(run: import("./types.js").RecurringJobRun): Record<string, unknown> {
  return {
    run_id: run.runId,
    job_id: run.jobId,
    trigger: run.trigger,
    scheduled_for: run.scheduledFor,
    session_id: run.sessionId,
    state: run.state,
    reason_code: run.reasonCode,
    reason_message: run.reasonMessage,
    job_snapshot: run.jobSnapshot,
    created_at: run.createdAt,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    updated_at: run.updatedAt,
  };
}

async function requireActor(
  options: RecurringJobRouteOptions,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<RecurringJobActor | undefined> {
  const actor = await options.resolveActor(request);
  if (!actor) {
    reply.code(401).send({ detail: { error: { code: "AUTHENTICATED_ACTOR_REQUIRED", message: "Authenticated user identity is required" } } });
    return undefined;
  }
  return actor;
}

function objectBody(value: unknown, reply: FastifyReply): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reply.code(422).send({ detail: { error: { code: "VALIDATION", message: "body must be an object" } } });
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringValue(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new RecurringJobError("VALIDATION", `${snake(key)} is required`, 422);
  return value;
}
function stringAlias(body: Record<string, unknown>, camel: string, snakeKey: string): string {
  return stringValue({ [camel]: body[camel] ?? body[snakeKey] }, camel);
}
function nullableStringAlias(body: Record<string, unknown>, camel: string, snakeKey: string): string | null {
  const value = body[camel] ?? body[snakeKey];
  if (value === null) return null;
  if (typeof value !== "string") throw new RecurringJobError("VALIDATION", `${snake(camel)} must be string or null`, 422);
  return value;
}
function integerAlias(body: Record<string, unknown>, camel: string, snakeKey: string): number {
  const value = body[camel] ?? body[snakeKey];
  if (!Number.isSafeInteger(value)) throw new RecurringJobError("VALIDATION", `${snake(camel)} must be an integer`, 422);
  return value as number;
}
function booleanValue(body: Record<string, unknown>, key: string): boolean {
  if (typeof body[key] !== "boolean") {
    throw new RecurringJobError("VALIDATION", `${snake(key)} must be boolean`, 422);
  }
  return body[key] as boolean;
}
function stringsValue(body: Record<string, unknown>, camel: string, snakeKey: string): string[] {
  const value = body[camel] ?? body[snakeKey];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RecurringJobError("VALIDATION", `${snake(camel)} must be a string array`, 422);
  }
  return [...value] as string[];
}
function containerValue(body: Record<string, unknown>): RecurringJobContainer {
  const value = body.container;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RecurringJobError("VALIDATION", "container must be an object", 422);
  }
  const container = value as Record<string, unknown>;
  if ((container.kind !== "folder" && container.kind !== "task") || typeof container.id !== "string") {
    throw new RecurringJobError("VALIDATION", "container must include kind and id", 422);
  }
  return { kind: container.kind, id: container.id };
}
function has(body: Record<string, unknown>, key: string): boolean { return Object.hasOwn(body, key); }
function snake(value: string): string { return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`); }
function numberQuery(request: FastifyRequest, key: string): number | undefined {
  const raw = (request.query as Record<string, unknown> | undefined)?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? Number(parsed) : undefined;
}
function booleanQuery(request: FastifyRequest, key: string): boolean {
  const raw = (request.query as Record<string, unknown> | undefined)?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === true || value === "true" || value === "1";
}
function recurringJobError(reply: FastifyReply, error: unknown) {
  if (error instanceof RecurringJobError) {
    return reply.code(error.statusCode).send({ detail: {
      error: {
        code: error.code,
        message: error.message,
        ...(error.currentJob ? { current_job: serializeJob(error.currentJob) } : {}),
      },
    } });
  }
  return reply.code(500).send({ detail: { error: {
    code: "RECURRING_JOB_OPERATION_FAILED",
    message: error instanceof Error ? error.message : "Recurring job operation failed",
  } } });
}
