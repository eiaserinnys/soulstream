import type { FastifyInstance, FastifyReply } from "fastify";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import {
  createInput,
  serializeJob,
  serializeRun,
  updateInput,
} from "./recurring_job_routes.js";
import { RecurringJobService } from "./service.js";
import { RecurringJobError, type RecurringJobActor } from "./types.js";

export type RecurringJobHostRouteOptions = {
  readonly service: RecurringJobService;
  readonly authBearerToken: string;
};

const operations = new Set([
  "list",
  "get",
  "preview",
  "create",
  "update",
  "run",
  "archive",
  "list_runs",
]);

/**
 * Internal callers may carry an agent-derived actor envelope, but only after
 * the service bearer boundary. The user-facing routes and this host boundary
 * both call the same service; neither accepts an owner embedded in a job.
 */
export function registerRecurringJobHostRoutes(
  app: FastifyInstance,
  options: RecurringJobHostRouteOptions,
): void {
  app.post<{ Params: { operation: string } }>(
    "/api/recurring-jobs/host/:operation",
    async (request, reply) => {
      const authorization = verifyServiceBearerAuthorization(
        request.headers.authorization,
        options.authBearerToken,
      );
      if (!authorization.ok) return hostError(reply, 401, "UNAUTHORIZED", `bearer token is ${authorization.reason}`);
      if (!operations.has(request.params.operation)) {
        return hostError(reply, 404, "RECURRING_JOB_OPERATION_NOT_FOUND", "unknown recurring job operation");
      }
      const body = objectValue(request.body);
      if (!body) return hostError(reply, 422, "VALIDATION", "body must be an object");
      const actor = actorValue(body.actor);
      if (!actor) return hostError(reply, 403, "FORBIDDEN", "verified recurring-job actor is required");
      try {
        return reply.send(await dispatch(options.service, request.params.operation, actor, body));
      } catch (error) {
        if (error instanceof RecurringJobError) {
          return hostError(reply, error.statusCode, error.code, error.message, error.currentJob);
        }
        request.log.error({ err: error, operation: request.params.operation }, "Recurring job host operation failed");
        return hostError(
          reply,
          500,
          "RECURRING_JOB_OPERATION_FAILED",
          error instanceof Error ? error.message : "Recurring job operation failed",
        );
      }
    },
  );
}

async function dispatch(
  service: RecurringJobService,
  operation: string,
  actor: RecurringJobActor,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (operation) {
    case "list":
      return { jobs: (await service.list(actor, body.includeArchived === true || body.include_archived === true)).map(serializeJob) };
    case "get":
      return { job: serializeJob(await service.get(actor, requiredString(body, "jobId", "job_id"), body.includeArchived === true || body.include_archived === true)) };
    case "preview":
      return service.preview({
        timezone: requiredString(body, "timezone"),
        scheduleExpressions: requiredStrings(body, "scheduleExpressions", "schedule_expressions"),
      });
    case "create":
      return { job: serializeJob(await service.create(actor, createInput(body))) };
    case "update":
      return { job: serializeJob(await service.update(actor, requiredString(body, "jobId", "job_id"), updateInput(body))) };
    case "run":
      return { run: serializeRun(await service.runManual(
        actor,
        requiredString(body, "jobId", "job_id"),
        requiredString(body, "idempotencyKey", "idempotency_key"),
      )) };
    case "archive":
      return { job: serializeJob(await service.archive(
        actor,
        requiredString(body, "jobId", "job_id"),
        requiredInteger(body, "expectedVersion", "expected_version"),
      )) };
    case "list_runs":
      return { runs: (await service.listRuns(
        actor,
        requiredString(body, "jobId", "job_id"),
        optionalInteger(body, "limit") ?? 50,
      )).map(serializeRun) };
    default:
      throw new Error(`unsupported recurring job operation: ${operation}`);
  }
}

function actorValue(value: unknown): RecurringJobActor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const actor = value as Record<string, unknown>;
  const source = actor.source;
  if (
    typeof actor.ownerEmail !== "string" || !actor.ownerEmail.trim() ||
    typeof actor.actorId !== "string" || !actor.actorId.trim() ||
    !actor.callerInfo || typeof actor.callerInfo !== "object" || Array.isArray(actor.callerInfo) ||
    (source !== "browser" && source !== "soul-app" && source !== "agent" && source !== "scheduler")
  ) return null;
  return {
    ownerEmail: actor.ownerEmail,
    actorId: actor.actorId,
    callerInfo: actor.callerInfo as Record<string, unknown>,
    source,
    ...(actor.isAdmin === true ? { isAdmin: true } : {}),
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function requiredString(body: Record<string, unknown>, camel: string, snake: string = camel): string {
  const value = body[camel] ?? body[snake];
  if (typeof value !== "string") throw new RecurringJobError("VALIDATION", `${snake} is required`, 422);
  return value;
}
function requiredStrings(body: Record<string, unknown>, camel: string, snake: string): string[] {
  const value = body[camel] ?? body[snake];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RecurringJobError("VALIDATION", `${snake} must be a string array`, 422);
  }
  return value as string[];
}
function optionalInteger(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return Number.isSafeInteger(value) ? value as number : undefined;
}
function requiredInteger(body: Record<string, unknown>, camel: string, snake: string): number {
  const value = body[camel] ?? body[snake];
  if (!Number.isSafeInteger(value)) throw new RecurringJobError("VALIDATION", `${snake} must be an integer`, 422);
  return value as number;
}
function hostError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  currentJob?: import("./types.js").RecurringJob,
) {
  return reply.code(statusCode).send({ detail: { error: {
    code,
    message,
    ...(currentJob ? { current_job: serializeJob(currentJob) } : {}),
  } } });
}
