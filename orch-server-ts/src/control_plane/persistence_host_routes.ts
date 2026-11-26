import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { NodeCredentialResolver } from "../node_credentials/types.js";
import type { PersistenceHostRepositories } from "./persistence_host_runtime.js";
import { hostRequestLogLevel } from "./host_request_log_level.js";
import { isLegacyHostDateValue } from "./repositories/session_mutation_repository.js";

export interface PersistenceHostRouteOptions {
  repositoryProvider: () => Promise<PersistenceHostRepositories>;
  authBearerToken: string;
  environment?: string;
  nodeCredentials: NodeCredentialResolver | null;
  /**
   * 지금 그 노드가 orch에 등록한 WebSocket 연결 시각(orch 시계, epoch ms).
   * 부팅 복구 클레임이 이번 연결 뒤에 접수된 배달까지 잡지 않도록 경계로
   * 넘긴다. 그 노드의 연결이 없으면 undefined를 돌려준다.
   */
  nodeConnectedAtMs?: (nodeId: string) => number | undefined;
  /**
   * 사람이 보낸 글(human_live_steer)이 전달 장부에서 dead_letter로 닫혔을 때
   * 세션마다 한 번 부른다. 클라이언트는 그 세션의 실패 목록을 다시 읽는다.
   */
  onSessionDeliveryFailed?: (sessionId: string) => void;
}

type RepositoryKey = keyof PersistenceHostRepositories;
type OperationTarget = readonly [RepositoryKey, string | null, string];
const OPAQUE_ARGUMENT_KEYS = new Set(["payload", "callerInfo"]);
const REQUEST_ID_HEADER = "x-soulstream-persistence-request-id";
const HOST_RECEIVED_AT_HEADER = "x-soulstream-host-received-at-ms";
const HOST_RESPONDED_AT_HEADER = "x-soulstream-host-responded-at-ms";
const CLAUDE_RUNTIME_BODY_LIMIT = 48 * 1024 * 1024;
const RETRY_DELAY_ARG_INDEX = new Map<string, number>([
  ["defer_pending", 2],
  ["retry_delivery_attempt", 3],
  ["defer_queued_transcript_check", 3],
]);

/**
 * 결과에서 사람 발신 dead_letter 행을 볼 수 있는 전달 연산. 나머지 연산은
 * 실패를 만들지 않는다.
 */
const DELIVERY_FAILURE_OPERATIONS = new Set([
  "mark_uncertain",
  "defer_pending",
  "retry_delivery_attempt",
  "expire_stale_delivery_attempts",
]);

const deliveryOperations = {
  register: ["deliveries", null, "register"],
  get: ["deliveries", null, "get"],
  get_by_relation: ["deliveries", null, "getByRelation"],
  get_relation_consumption: ["deliveries", null, "getRelationConsumption"],
  record_relation_consumed: ["deliveries", null, "recordRelationConsumed"],
  record_observed_child_completion: ["deliveries", null, "recordObservedChildCompletion"],
  record_observed_child_completions: ["deliveries", null, "recordObservedChildCompletions"],
  claim: ["deliveries", null, "claim"],
  claim_attempt_for_target: ["deliveries", null, "claimAttemptForTarget"],
  begin_dispatch: ["deliveries", null, "beginDispatch"],
  claim_recoverable_completion_deliveries: ["deliveries", null, "claimRecoverableCompletionDeliveries"],
  defer_pending: ["deliveries", null, "deferPending"],
  retry_delivery_attempt: ["deliveries", null, "retryDeliveryAttempt"],
  mark_pending_superseded: ["deliveries", null, "markPendingSuperseded"],
  expire_stale_delivery_attempts: ["deliveries", null, "expireStaleDeliveryAttempts"],
  mark_queued: ["deliveries", null, "markQueued"],
  mark_delivered: ["deliveries", null, "markDelivered"],
  mark_consumed: ["deliveries", null, "markConsumed"],
  mark_consumed_by_relation: ["deliveries", null, "markConsumedByRelation"],
  mark_uncertain: ["deliveries", null, "markUncertain"],
  stage_notification_with_queued_delivery: ["deliveries", "notifications", "stageWithQueuedDelivery"],
  get_notification: ["deliveries", "notifications", "get"],
  claim_due_notifications: ["deliveries", "notifications", "claimDue"],
  mark_notification_published: ["deliveries", "notifications", "markPublished"],
  retry_notification: ["deliveries", "notifications", "retry"],
  dead_letter_notification: ["deliveries", "notifications", "deadLetter"],
  list_dead_letter_notifications: ["deliveries", "notifications", "listDeadLetters"],
  requeue_dead_letter_notification: ["deliveries", "notifications", "requeueDeadLetter"],
  expire_stale_notification_attempts: ["deliveries", "notifications", "expireStaleNotificationAttempts"],
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
  active_background_tasks_for_session: ["claudeBackgroundTasks", null, "activeForSession"],
  terminal_background_tasks_for_node: ["claudeBackgroundTasks", null, "terminalForNode"],
  mark_background_tasks_startup_reconciled: ["claudeBackgroundTasks", null, "markStartupReconciled"],
  observe_background_generation: ["claudeBackgroundTasks", null, "observeGeneration"],
  terminalize_background_generation: ["claudeBackgroundTasks", null, "terminalizeGeneration"],
  get_background_generation: ["claudeBackgroundTasks", null, "getGeneration"],
  active_background_generations_for_node: ["claudeBackgroundTasks", null, "activeGenerationsForNode"],
  active_background_generations_for_execution: ["claudeBackgroundTasks", null, "activeGenerationsForExecution"],
  resolve_background_generation: ["claudeBackgroundTasks", null, "resolveGeneration"],
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

/** session-data 호스트 화이트리스트. 시험이 전체 목록을 볼 수 있게 내보낸다. */
export const sessionDataOperations = {
  put_report_entry: ["persistentReports", null, "put"],
  remove_report_entry: ["persistentReports", null, "remove"],
  register_session: ["sessionMutations", null, "registerSession"],
  register_session_with_worktree: ["sessionMutations", null, "registerSessionWithWorktree"],
  transition_session: ["sessionMutations", null, "transitionSession"],
  rename_session: ["sessionMutations", null, "renameSession"],
  delete_session: ["sessionMutations", null, "deleteSession"],
  acknowledge_review: ["sessionMutations", null, "acknowledgeReview"],
  set_model_selection: ["sessionMutations", null, "setModelSelection"],
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
  history_search: ["historySearch", null, "search"],
  story_search_metadata: ["storyReads", null, "getSessionSearchMetadata"],
  turn_summary_count: ["storyReads", null, "countTurnSummaries"],
  turn_summary_range: ["storyReads", null, "loadTurnSummaryRange"],
  digest_search: ["storyReads", null, "searchSessionDigests"],
  story: ["storyReads", null, "getSessionStory"],
  turn_excerpt: ["sessionReadComposites", null, "getTurnExcerpt"],
  resume_context: ["sessionReadComposites", null, "getResumeContext"],
  generation_checkpoint_material: ["sessionReadComposites", null, "getGenerationCheckpointMaterial"],
  caller_chain: ["sessionReads", null, "getSessionCallerChain"],
  owner_node: ["sessionReads", null, "getSessionOwnerNode"],
  existing_session_ids: ["sessionReads", null, "listExistingSessionIds"],
} as const satisfies Record<string, OperationTarget>;

const worktreeOperations = {
  sweep_candidates: ["worktrees", null, "sweepCandidates"],
  list: ["worktrees", null, "list"],
  register: ["worktrees", null, "register"],
  update_setup: ["worktrees", null, "updateSetup"],
  begin_remove: ["worktrees", null, "beginRemove"],
  restore_ready: ["worktrees", null, "restoreReady"],
  finish_remove: ["worktrees", null, "finishRemove"],
  begin_branch_delete: ["worktrees", null, "beginBranchDelete"],
  finish_branch_delete: ["worktrees", null, "finishBranchDelete"],
  resolve_execution: ["worktrees", null, "resolveExecution"],
} as const satisfies Record<string, OperationTarget>;

export function registerPersistenceHostRoutes(
  app: FastifyInstance,
  options: PersistenceHostRouteOptions,
): void {
  registerDomain(app, options, "session-deliveries", deliveryOperations);
  registerDomain(app, options, "claude-runtime", claudeRuntimeOperations);
  registerDomain(app, options, "session-page-bindings", pageBindingOperations);
  registerDomain(app, options, "session-data", sessionDataOperations);
  registerDomain(app, options, "worktrees", worktreeOperations);
}

function registerDomain(
  app: FastifyInstance,
  options: PersistenceHostRouteOptions,
  domain: string,
  operations: Record<string, OperationTarget>,
): void {
  app.post<{ Params: { operation: string } }>(
    `/api/${domain}/host/:operation`,
    domain === "claude-runtime" ? { bodyLimit: CLAUDE_RUNTIME_BODY_LIMIT } : {},
    async (request, reply) => {
      const timing = beginHostTiming(request, domain, request.params.operation);
      const authorization = verifyServiceBearerAuthorization(
        request.headers.authorization,
        {
          configuredToken: options.authBearerToken,
          environment: options.environment,
          nodeCredentials: options.nodeCredentials,
        },
      );
      if (!authorization.ok) {
        return sendTimed(request, reply, timing, authorization.statusCode, () =>
          errorReply(reply, authorization.statusCode, "UNAUTHORIZED", `bearer token is ${authorization.reason}`));
      }
      const target = operations[request.params.operation];
      if (!target) {
        return sendTimed(request, reply, timing, 404, () =>
          errorReply(reply, 404, "HOST_OPERATION_NOT_FOUND", `unknown ${domain} operation`));
      }
      const rawArgs = readArgs(request.body, request.params.operation);
      if (!rawArgs) {
        return sendTimed(request, reply, timing, 422, () =>
          errorReply(reply, 422, "INVALID_HOST_REQUEST", "body.args must be an array"));
      }
      if (domain === "session-data" && request.params.operation === "existing_session_ids"
        && (rawArgs.length !== 1 || !Array.isArray(rawArgs[0])
          || rawArgs[0].length > 500 || !rawArgs[0].every((id: unknown) => typeof id === "string"))) {
        return sendTimed(request, reply, timing, 400, () =>
          errorReply(reply, 400, "INVALID_HOST_REQUEST", "expected an array of at most 500 session ids"));
      }
      const args = normalizeRetryDelay(request.params.operation, rawArgs);
      if (!args) {
        return sendTimed(request, reply, timing, 422, () =>
          errorReply(reply, 422, "INVALID_HOST_REQUEST", "retry delay must be a duration or absolute instant"));
      }
      const routedArgs = request.params.operation === "claim_queued_after_node_restart"
        ? withRestartClaimCutoff(args, options.nodeConnectedAtMs)
        : args;
      // 사람이 보낸 글이 dead_letter로 닫히면 그 세션을 열고 있는 클라이언트가
      // 바로 알아야 한다. 커밋이 끝난 뒤(호출 반환 뒤) 세션마다 한 번 알린다.
      const deliveryFailureCollector = options.onSessionDeliveryFailed !== undefined
        && domain === "session-deliveries"
        && DELIVERY_FAILURE_OPERATIONS.has(request.params.operation)
        ? createDeliveryFailureCollector(options.onSessionDeliveryFailed)
        : undefined;
      const invokeArgs = deliveryFailureCollector !== undefined
        && request.params.operation === "expire_stale_delivery_attempts"
        // 이 연산은 결과가 개수(number)뿐이라 관찰자 인자로 마감된 행을 받는다.
        ? [...routedArgs, deliveryFailureCollector.observe]
        : routedArgs;
      const isCancellableOperation = domain === "session-data"
        && [
          "event_search", "event_session_id_search", "digest_search", "history_search",
          // 노드가 5초에 HTTP를 끊어도 공유 풀 질의가 statement_timeout(30초)까지
          // 남지 않도록 조회도 같은 신호로 취소한다.
          "event_read_page", "event_count",
        ].includes(request.params.operation);
      const abortController = isCancellableOperation ? new AbortController() : undefined;
      const onRequestAborted = () => abortController?.abort();
      const onResponseClosed = () => {
        if (!reply.raw.writableFinished) abortController?.abort();
      };
      if (abortController) {
        request.raw.once("aborted", onRequestAborted);
        reply.raw.once("close", onResponseClosed);
      }
      try {
        const repositories = await options.repositoryProvider();
        const result = await invoke(
          repositories,
          target,
          abortController
            ? withAbortSignal(request.params.operation, invokeArgs, abortController.signal)
            : invokeArgs,
        );
        if (deliveryFailureCollector !== undefined) {
          for (const row of deliveryResultRows(result)) {
            deliveryFailureCollector.observe(row);
          }
          deliveryFailureCollector.notifyAll();
        }
        return sendTimed(request, reply, timing, 200, () =>
          reply.type("application/json").send(JSON.stringify(result ?? null)));
      } catch (error) {
        if (request.raw.aborted || reply.raw.destroyed) return reply;
        const statusCode = (error as { statusCode?: unknown } | undefined)?.statusCode;
        const status = typeof statusCode === "number" ? statusCode : 500;
        const domainCode = (error as { code?: unknown } | undefined)?.code;
        const code = typeof domainCode === "string" ? domainCode : "HOST_OPERATION_FAILED";
        if (status < 500) {
          request.log.warn({ domain, operation: request.params.operation, statusCode: status, code }, "Persistence host operation failed");
        } else {
          request.log.error({ err: error, domain, operation: request.params.operation }, "Persistence host operation failed");
        }
        return sendTimed(request, reply, timing, status, () =>
          errorReply(
            reply,
            status,
            code,
            error instanceof Error ? error.message : "Persistence host operation failed",
          ));
      } finally {
        if (abortController) {
          request.raw.removeListener("aborted", onRequestAborted);
          reply.raw.removeListener("close", onResponseClosed);
        }
      }
    },
  );
}

interface PersistenceHostTiming {
  requestId: string | null;
  domain: string;
  operation: string;
  hostReceivedAtMs: number;
}

function beginHostTiming(
  request: FastifyRequest,
  domain: string,
  operation: string,
): PersistenceHostTiming {
  const rawRequestId = request.headers[REQUEST_ID_HEADER];
  return {
    requestId: typeof rawRequestId === "string" && rawRequestId.length > 0 ? rawRequestId : null,
    domain,
    operation,
    hostReceivedAtMs: Date.now(),
  };
}

function sendTimed(
  request: FastifyRequest,
  reply: FastifyReply,
  timing: PersistenceHostTiming,
  statusCode: number,
  send: () => FastifyReply,
): FastifyReply {
  const hostRespondedAtMs = Date.now();
  if (timing.requestId) reply.header(REQUEST_ID_HEADER, timing.requestId);
  reply.header(HOST_RECEIVED_AT_HEADER, String(timing.hostReceivedAtMs));
  reply.header(HOST_RESPONDED_AT_HEADER, String(hostRespondedAtMs));
  const response = send();
  const hostDurationMs = hostRespondedAtMs - timing.hostReceivedAtMs;
  request.log[hostRequestLogLevel(statusCode, hostDurationMs)](
    {
      ...timing,
      hostRespondedAtMs,
      hostDurationMs,
      statusCode,
    },
    "Persistence host response sent",
  );
  return response;
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

function readArgs(value: unknown, operation: string): unknown[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const args = (value as Record<string, unknown>).args;
  if (!Array.isArray(args)) return null;
  return args.map((child, index) => {
    if (operation === "put_report_entry" && index === 1) return child;
    return camelCase(child, undefined, OPAQUE_ARGUMENT_KEYS);
  });
}

/**
 * 저장소 메서드의 마지막 signal 자리에 중단 신호를 붙인다. event_read_page는
 * 노드가 선택 인자를 생략해 보내므로(예: [sessionId, afterId, limit, eventTypes])
 * 빠진 자리를 null로 채워 신호가 마지막 자리에 오게 한다.
 */
function withAbortSignal(
  operation: string,
  args: unknown[],
  signal: AbortSignal,
): unknown[] {
  if (operation !== "event_read_page") return [...args, signal];
  const padded = [...args];
  while (padded.length < 7) padded.push(null);
  return [...padded, signal];
}

/**
 * 부팅 복구 클레임에 그 노드의 지금 연결 등록 시각을 마지막 인자로 붙인다.
 * 저장소는 이 시각 이전에 queued된 행만 잡는다. 연결이 레지스트리에 없으면
 * 시각을 붙이지 않아 지금처럼 조건 없이 클레임한다(행이 영영 남지 않게).
 */
function withRestartClaimCutoff(
  args: unknown[],
  nodeConnectedAtMs: PersistenceHostRouteOptions["nodeConnectedAtMs"],
): unknown[] {
  if (!nodeConnectedAtMs) return args;
  const nodeId = args[0];
  if (typeof nodeId !== "string" || nodeId.length === 0) return args;
  const connectedAtMs = nodeConnectedAtMs(nodeId);
  if (typeof connectedAtMs !== "number" || !Number.isFinite(connectedAtMs)) return args;
  return [...args, connectedAtMs];
}

function normalizeRetryDelay(operation: string, args: unknown[]): unknown[] | null {
  const index = RETRY_DELAY_ARG_INDEX.get(operation);
  if (index === undefined) return args;
  const value = args[index];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return args;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  // Rolling upgrades may still send the pre-#797 absolute retry instant.
  const normalized = [...args];
  normalized[index] = Math.max(0, value.getTime() - Date.now());
  return normalized;
}

function camelCase(
  value: unknown,
  key?: string,
  opaqueKeys: ReadonlySet<string> = OPAQUE_ARGUMENT_KEYS,
): unknown {
  if (Array.isArray(value)) {
    return value.map(child => camelCase(child, undefined, opaqueKeys));
  }
  if (typeof value === "string" && isLegacyHostDateValue(value, key)) return new Date(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => {
    const camelKey = childKey.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    return [
      camelKey,
      opaqueKeys.has(camelKey) ? child : camelCase(child, camelKey, opaqueKeys),
    ];
  }));
}

type DeliveryFailureCollector = {
  observe: (row: unknown) => void;
  notifyAll: () => void;
};

function createDeliveryFailureCollector(
  onSessionDeliveryFailed: (sessionId: string) => void,
): DeliveryFailureCollector {
  const sessionIds = new Set<string>();
  return {
    observe: (row) => {
      const sessionId = humanDeadLetterSessionId(row);
      if (sessionId !== null) sessionIds.add(sessionId);
    },
    notifyAll: () => {
      for (const sessionId of sessionIds) onSessionDeliveryFailed(sessionId);
    },
  };
}

/**
 * 사람이 보낸 글(human_live_steer)이 전달 장부에서 dead_letter로 닫힌 행인가.
 * 에이전트 발신(caller_info.source=agent)은 사람 화면에 실패로 보이면 안 되므로
 * 뺀다. 대상 세션이 비어 있으면(삭제로 target이 비워진 줄) 알릴 곳이 없다.
 */
function humanDeadLetterSessionId(row: unknown): string | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  if (record.intent !== "human_live_steer") return null;
  if (record.aggregate_state !== "dead_letter") return null;
  const sessionId = record.target_session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const payload = record.payload;
  const callerInfo = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).caller_info
    : null;
  const source = callerInfo !== null && typeof callerInfo === "object" && !Array.isArray(callerInfo)
    ? (callerInfo as Record<string, unknown>).source
    : undefined;
  return source === "agent" ? null : sessionId;
}

function deliveryResultRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  return result !== null && typeof result === "object" ? [result] : [];
}

function errorReply(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ detail: { error: { code, message } } });
}
