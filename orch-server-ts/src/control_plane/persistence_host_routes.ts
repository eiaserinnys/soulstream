import type { FastifyInstance, FastifyReply } from "fastify";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { PersistenceHostRepositories } from "./persistence_host_runtime.js";

export interface PersistenceHostRouteOptions {
  repositoryProvider: () => Promise<PersistenceHostRepositories>;
  authBearerToken: string;
}

type RepositoryKey = keyof PersistenceHostRepositories;
type OperationTarget = readonly [RepositoryKey, string | null, string];

const deliveryOperations = {
  register: ["deliveries", null, "register"],
  get: ["deliveries", null, "get"],
  get_by_relation: ["deliveries", null, "getByRelation"],
  get_relation_consumption: ["deliveries", null, "getRelationConsumption"],
  record_relation_consumed: ["deliveries", null, "recordRelationConsumed"],
  record_observed_child_completion: ["deliveries", null, "recordObservedChildCompletion"],
  record_observed_child_completions: ["deliveries", null, "recordObservedChildCompletions"],
  claim: ["deliveries", null, "claim"],
  claim_for_target: ["deliveries", null, "claimForTarget"],
  begin_dispatch: ["deliveries", null, "beginDispatch"],
  claim_recoverable_completion_deliveries: ["deliveries", null, "claimRecoverableCompletionDeliveries"],
  defer_pending: ["deliveries", null, "deferPending"],
  retry_leased_delivery: ["deliveries", null, "retryLeasedDelivery"],
  release_expired_delivery_leases: ["deliveries", null, "releaseExpiredDeliveryLeases"],
  mark_queued: ["deliveries", null, "markQueued"],
  mark_delivered: ["deliveries", null, "markDelivered"],
  mark_consumed: ["deliveries", null, "markConsumed"],
  mark_consumed_by_relation: ["deliveries", null, "markConsumedByRelation"],
  mark_uncertain: ["deliveries", null, "markUncertain"],
  stage_notification_with_queued_delivery: ["deliveries", "notifications", "stageWithQueuedDelivery"],
  claim_due_notifications: ["deliveries", "notifications", "claimDue"],
  mark_notification_published: ["deliveries", "notifications", "markPublished"],
  retry_notification: ["deliveries", "notifications", "retry"],
  release_expired_notification_leases: ["deliveries", "notifications", "releaseExpiredLeases"],
  claim_queued_after_node_restart: ["deliveries", "recovery", "claimQueuedAfterNodeRestart"],
  claim_recoverable_queued: ["deliveries", "recovery", "claimRecoverableQueued"],
  mark_delivered_from_transcript: ["deliveries", "recovery", "markDeliveredFromTranscript"],
  defer_queued_transcript_check: ["deliveries", "recovery", "deferQueuedTranscriptCheck"],
} as const satisfies Record<string, OperationTarget>;

const claudeRuntimeOperations = {
  observe_background_task: ["claudeBackgroundTasks", null, "observe"],
  terminalize_background_task: ["claudeBackgroundTasks", null, "terminalize"],
  get_background_task: ["claudeBackgroundTasks", null, "get"],
  active_background_tasks_for_node: ["claudeBackgroundTasks", null, "activeForNode"],
  append_transcript_entries: ["claudeTranscripts", null, "appendClaudeTranscriptEntries"],
  append_transcript_entries_idempotent: ["claudeTranscripts", null, "appendClaudeTranscriptEntriesIdempotent"],
  load_transcript_entries: ["claudeTranscripts", null, "loadClaudeTranscriptEntries"],
  list_transcript_sessions: ["claudeTranscripts", null, "listClaudeTranscriptSessions"],
  list_transcript_subkeys: ["claudeTranscripts", null, "listClaudeTranscriptSubkeys"],
  delete_transcript: ["claudeTranscripts", null, "deleteClaudeTranscript"],
  delete_transcript_idempotent: ["claudeTranscripts", null, "deleteClaudeTranscriptIdempotent"],
} as const satisfies Record<string, OperationTarget>;

const pageBindingOperations = {
  enqueue: ["sessionPageBindings", null, "enqueue"],
  get: ["sessionPageBindings", null, "get"],
  list_for_sessions: ["sessionPageBindings", null, "listForSessions"],
  list_due: ["sessionPageBindings", null, "listDue"],
  mark_page_bound: ["sessionPageBindings", null, "markPageBound"],
  mark_legacy_completed: ["sessionPageBindings", null, "markLegacyCompleted"],
  mark_failure: ["sessionPageBindings", null, "markFailure"],
} as const satisfies Record<string, OperationTarget>;

const sessionDataOperations = {
  register_session: ["sessionMutations", null, "registerSession"],
  transition_session: ["sessionMutations", null, "transitionSession"],
  rename_session: ["sessionMutations", null, "renameSession"],
  delete_session: ["sessionMutations", null, "deleteSession"],
  acknowledge_review: ["sessionMutations", null, "acknowledgeReview"],
  get: ["sessionReads", null, "getSession"],
  list_summary: ["sessionReads", null, "listSessionsSummary"],
  list_running: ["sessionReads", null, "listRunningSessionsSummary"],
  upstream_dump: ["sessionReads", null, "listSessionsForUpstreamDump"],
  event_count: ["eventReads", null, "countEvents"],
  event_read_page: ["eventReads", null, "readEvents"],
  event_read_one: ["eventReads", null, "readOneEvent"],
  event_raw_page: ["eventReads", null, "streamEventsRaw"],
  event_search: ["eventReads", null, "searchEvents"],
  event_session_id_search: ["eventReads", null, "searchEventsBySessionId"],
  story_search_metadata: ["storyReads", null, "getSessionSearchMetadata"],
  turn_summary_count: ["storyReads", null, "countTurnSummaries"],
  turn_summary_range: ["storyReads", null, "loadTurnSummaryRange"],
  digest_search: ["storyReads", null, "searchSessionDigests"],
  story: ["storyReads", null, "getSessionStory"],
  turn_excerpt: ["sessionReadComposites", null, "getTurnExcerpt"],
  resume_context: ["sessionReadComposites", null, "getResumeContext"],
} as const satisfies Record<string, OperationTarget>;

export function registerPersistenceHostRoutes(
  app: FastifyInstance,
  options: PersistenceHostRouteOptions,
): void {
  registerDomain(app, options, "session-deliveries", deliveryOperations);
  registerDomain(app, options, "claude-runtime", claudeRuntimeOperations);
  registerDomain(app, options, "session-page-bindings", pageBindingOperations);
  registerDomain(app, options, "session-data", sessionDataOperations);
}

function registerDomain(
  app: FastifyInstance,
  options: PersistenceHostRouteOptions,
  domain: string,
  operations: Record<string, OperationTarget>,
): void {
  app.post<{ Params: { operation: string } }>(
    `/api/${domain}/host/:operation`,
    async (request, reply) => {
      const authorization = verifyServiceBearerAuthorization(
        request.headers.authorization,
        options.authBearerToken,
      );
      if (!authorization.ok) {
        return errorReply(reply, 401, "UNAUTHORIZED", `bearer token is ${authorization.reason}`);
      }
      const target = operations[request.params.operation];
      if (!target) return errorReply(reply, 404, "HOST_OPERATION_NOT_FOUND", `unknown ${domain} operation`);
      const args = readArgs(request.body);
      if (!args) return errorReply(reply, 422, "INVALID_HOST_REQUEST", "body.args must be an array");
      try {
        const repositories = await options.repositoryProvider();
        const result = await invoke(repositories, target, args);
        return reply.type("application/json").send(JSON.stringify(result ?? null));
      } catch (error) {
        request.log.error({ err: error, domain, operation: request.params.operation }, "Persistence host operation failed");
        const statusCode = (error as { statusCode?: unknown } | undefined)?.statusCode;
        return errorReply(
          reply,
          typeof statusCode === "number" ? statusCode : 500,
          "HOST_OPERATION_FAILED",
          error instanceof Error ? error.message : "Persistence host operation failed",
        );
      }
    },
  );
}

type CallableTarget = Record<string, (...args: never[]) => unknown>;

async function invoke(
  repositories: PersistenceHostRepositories,
  [repositoryKey, childKey, method]: OperationTarget,
  args: unknown[],
): Promise<unknown> {
  const repository = repositories[repositoryKey] as unknown as Record<string, unknown>;
  const target = (childKey ? repository[childKey] : repository) as CallableTarget;
  const callable = target[method];
  if (typeof callable !== "function") throw new Error(`host method is not callable: ${method}`);
  return await callable.apply(target, args as never[]);
}

function readArgs(value: unknown): unknown[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const args = (value as Record<string, unknown>).args;
  return Array.isArray(args) ? args.map(child => camelCase(child)) : null;
}

function camelCase(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map(child => camelCase(child));
  if (typeof value === "string" && isDateValue(value, key)) return new Date(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => {
    const camelKey = childKey.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    return [camelKey, camelCase(child, camelKey)];
  }));
}

function isDateValue(value: string, key?: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  if (key === undefined) return true;
  return /(?:At|Before|Until|ExpiresAt)$/.test(key) && key !== "timestamp";
}

function errorReply(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ detail: { error: { code, message } } });
}
