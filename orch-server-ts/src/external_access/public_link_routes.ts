import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ConversationHistorySource } from "../conversation/conversation_history.js";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import { buildAccessLinkUrl } from "./access_link_routes.js";
import {
  buildAccessLinkGuidance,
  type ExternalAccessTarget,
} from "./access_link_guidance.js";
import type { ExternalAccessTokenBucket } from "./external_access_token_bucket.js";
import {
  type ExternalAccessGrant,
  type ExternalAccessPermission,
} from "./external_access_grant_repository.js";
import type { ExternalReplySignal } from "./external_reply_signal.js";
import {
  EXTERNAL_READ_RATE_PER_MINUTE,
  EXTERNAL_SEND_RATE_PER_MINUTE,
  type AdmitExternalInputResult,
  type ExternalRequestStatus,
  type ReadExternalRequestStatusResult,
} from "./external_input_service.js";

/**
 * The public access link surface (design 3.2, 2.6, 2.7).
 *
 * Five routes under `/x/:key` are the only unauthenticated HTTP surface; the
 * key itself is the credential. Every request resolves the grant again, a
 * resolved grant must be a `link` grant (webhook keys are rejected with the
 * same 401), and each response carries no-store/no-referrer headers.
 */

export const externalAccessPublicRouteAuthRequirements = {
  "GET /x/:key": false,
  "POST /x/:key/messages": false,
  "GET /x/:key/messages/:requestId": false,
  "GET /x/:key/history": false,
  "POST /x/:key/stop": false,
} as const;

export const EXTERNAL_ACCESS_MESSAGE_BODY_LIMIT = 256 * 1024;
export const EXTERNAL_ACCESS_MAX_WAIT_SECONDS = 25;
const STATUS_REREAD_MIN_INTERVAL_MS = 1_000;

export type ExternalAccessStopOutcome =
  | "stopped"
  | "not_running"
  | "unavailable";

export type ExternalAccessStopSession = (
  targetSessionId: string,
) => Promise<ExternalAccessStopOutcome>;

export interface ExternalAccessHistoryItem {
  id: string;
  kind: "user" | "assistant" | "error" | "notice";
  text: string;
  at: string;
  sender?: { kind: "external"; label: string };
}

export interface ExternalAccessPublicRouteOptions {
  /** Used only to read the target's display name for the guidance. */
  sql: SqlClient;
  publicUrl: string;
  grants: {
    resolveGrant(
      rawKey: string,
      requiredPermission?: ExternalAccessPermission,
    ): Promise<
      | { ok: true; grant: ExternalAccessGrant }
      | { ok: false; code: "unauthorized" | "forbidden"; status: 401 | 403 }
    >;
    touchLastUsedAt(grantId: string): Promise<void>;
  };
  inputService: {
    admit(
      grant: ExternalAccessGrant,
      input: { text: string; request_id?: string },
    ): Promise<AdmitExternalInputResult>;
    readExternalRequestStatus(
      grant: ExternalAccessGrant,
      requestId: string,
      options?: { consumeRate?: boolean },
    ): Promise<ReadExternalRequestStatusResult>;
  };
  history: {
    load(source: ConversationHistorySource): Promise<{
      items: ReadonlyArray<{ item: ExternalAccessHistoryItem }>;
    }>;
  };
  stopSession: ExternalAccessStopSession;
  tokenBucket: Pick<ExternalAccessTokenBucket, "take">;
  eventHub: { subscribe(agentSessionId: string, listener: () => void): () => void };
  replySignal: ExternalReplySignal;
  readRatePerMinute?: number;
  sendRatePerMinute?: number;
  now?: () => number;
}

type RouteParams = { key: string };
type MessageParams = { key: string; requestId: string };

const messageBodySchema = z
  .object({
    text: z.string(),
    request_id: z.string().optional(),
  })
  .strict();

type LinkGrantAccess =
  | { ok: true; grant: ExternalAccessGrant }
  | { ok: false; status: 401 | 403 };

export function registerExternalAccessPublicRoutes(
  app: FastifyInstance,
  options: ExternalAccessPublicRouteOptions,
): void {
  app.register(
    async (instance) => {
      // Production registers a root multipart/form-data parser for
      // attachments, which an encapsulated plugin would inherit. The public
      // link surface parses only JSON; every other POST content type is a
      // fixed 415 before any parser runs.
      instance.removeAllContentTypeParsers();
      instance.addContentTypeParser(
        "application/json",
        { parseAs: "string" },
        (_request, body, done) => {
          const text = typeof body === "string" ? body : body.toString("utf8");
          if (text.length === 0) {
            done(invalidJsonError("Empty JSON body"), undefined);
            return;
          }
          try {
            done(null, JSON.parse(text));
          } catch {
            done(invalidJsonError("Invalid JSON body"), undefined);
          }
        },
      );
      instance.addHook("onRequest", async (_request, reply) => {
        applyNoStoreHeaders(reply);
      });

      instance.get<{ Params: RouteParams }>("/:key", async (request, reply) => {
        const resolved = await resolveLinkGrant(options, request.params.key);
        if (!resolved.ok) return sendAccessFailure(reply, resolved.status);
        const rate = takeReadRate(options, resolved.grant.id);
        if (!rate.allowed) return sendRateLimited(reply, rate.retryAfterSeconds);
        const target = await readTargetDisplay(
          options.sql,
          resolved.grant.target_session_id,
        );
        const guidance = buildAccessLinkGuidance(
          resolved.grant,
          target,
          buildAccessLinkUrl(options.publicUrl, request.params.key),
          acceptsJson(request.headers.accept),
        );
        return reply.type(guidance.contentType).send(guidance.body);
      });

      instance.post<{ Params: RouteParams }>(
        "/:key/messages",
        { bodyLimit: EXTERNAL_ACCESS_MESSAGE_BODY_LIMIT },
        async (request, reply) => {
          const resolved = await resolveLinkGrant(options, request.params.key, "send");
          if (!resolved.ok) return sendAccessFailure(reply, resolved.status);
          const parsed = messageBodySchema.safeParse(request.body);
          if (!parsed.success) {
            return sendError(
              reply,
              400,
              "invalid_request",
              "Body must be a JSON object with text and optional request_id",
            );
          }
          if (parsed.data.text.trim().length === 0) {
            return sendError(reply, 400, "empty_text", "text must not be empty");
          }
          const admitted = await options.inputService.admit(resolved.grant, {
            text: parsed.data.text,
            ...(parsed.data.request_id === undefined
              ? {}
              : { request_id: parsed.data.request_id }),
          });
          if (!admitted.ok) {
            switch (admitted.reason) {
              case "conflict":
                return sendError(
                  reply,
                  409,
                  "request_conflict",
                  "request_id was already used with a different text",
                );
              case "invalid_request_id":
                return sendError(
                  reply,
                  400,
                  "invalid_request_id",
                  "request_id must be a non-empty string of at most 200 characters",
                );
              case "rate_limited":
                return sendRateLimited(reply, admitted.retry_after_seconds);
            }
          }
          return reply.code(202).send({
            request_id: admitted.request_id,
            status: admitted.status,
          });
        },
      );

      instance.get<{ Params: MessageParams }>(
        "/:key/messages/:requestId",
        async (request, reply) => {
          const waitSeconds = parseWaitSeconds(
            (request.query as { wait?: unknown }).wait,
          );
          if (waitSeconds === null) {
            return sendError(
              reply,
              400,
              "invalid_request",
              `wait must be an integer between 0 and ${EXTERNAL_ACCESS_MAX_WAIT_SECONDS}`,
            );
          }
          const resolved = await resolveLinkGrant(
            options,
            request.params.key,
            "read_own",
          );
          if (!resolved.ok) return sendAccessFailure(reply, resolved.status);
          const grant = resolved.grant;
          const first = await options.inputService.readExternalRequestStatus(
            grant,
            request.params.requestId,
          );
          if (!first.ok) {
            return first.reason === "not_found"
              ? sendError(reply, 404, "not_found", "Request not found")
              : sendRateLimited(reply, first.retry_after_seconds);
          }
          let status = first.status;
          if (waitSeconds > 0 && !isTerminalStatus(status.status)) {
            status = await holdForStatusChange(
              options,
              grant,
              request.params.requestId,
              status,
              waitSeconds,
              reply,
            );
          }
          // A link expired or revoked while the response was held still ends
          // the request without data (design 2.6, 3.3).
          const recheck = await resolveLinkGrant(
            options,
            request.params.key,
            "read_own",
          );
          if (!recheck.ok) return sendAccessFailure(reply, recheck.status);
          await options.grants.touchLastUsedAt(recheck.grant.id);
          return reply.send(status);
        },
      );

      instance.get<{ Params: RouteParams }>("/:key/history", async (request, reply) => {
        const query = parseHistoryQuery(request.query);
        if (query === null) {
          return sendError(
            reply,
            400,
            "invalid_request",
            "limit must be an integer between 1 and 50",
          );
        }
        const resolved = await resolveLinkGrant(
          options,
          request.params.key,
          "read_history",
        );
        if (!resolved.ok) return sendAccessFailure(reply, resolved.status);
        const rate = takeReadRate(options, resolved.grant.id);
        if (!rate.allowed) return sendRateLimited(reply, rate.retryAfterSeconds);
        const loaded = await options.history.load({
          session_id: resolved.grant.target_session_id,
          first_input_is_initial_instruction: false,
          creation_request: null,
          notices: [],
        });
        const visible = loaded.items
          .map((entry) => entry.item)
          .filter(isVisibleHistoryItem);
        let end = visible.length;
        if (query.before !== undefined) {
          end = visible.findIndex((item) => item.id === query.before);
          if (end < 0) {
            return sendError(reply, 400, "invalid_before", "Unknown before cursor");
          }
        }
        const start = Math.max(0, end - query.limit);
        const slice = visible.slice(start, end);
        await options.grants.touchLastUsedAt(resolved.grant.id);
        return reply.send({
          items: slice.map((item) => ({
            id: item.id,
            role: item.kind,
            text: item.text,
            at: item.at,
            ...(item.sender === undefined ? {} : { sender: item.sender }),
          })),
          ...(start > 0 && slice.length > 0
            ? { next_before: slice[0]!.id }
            : {}),
        });
      });

      instance.post<{ Params: RouteParams }>("/:key/stop", async (request, reply) => {
        const resolved = await resolveLinkGrant(options, request.params.key, "control");
        if (!resolved.ok) return sendAccessFailure(reply, resolved.status);
        const rate = options.tokenBucket.take(
          `send:${resolved.grant.id}`,
          options.sendRatePerMinute ?? EXTERNAL_SEND_RATE_PER_MINUTE,
        );
        if (!rate.allowed) return sendRateLimited(reply, rate.retryAfterSeconds);
        const outcome = await stopSession(options, resolved.grant.target_session_id);
        if (outcome === "unavailable") {
          return sendError(
            reply,
            503,
            "control_unavailable",
            "Session control is temporarily unavailable",
          );
        }
        if (outcome === "not_running") {
          return sendError(reply, 409, "not_running", "Session is not running");
        }
        await options.grants.touchLastUsedAt(resolved.grant.id);
        return reply.send({ ok: true });
      });

      instance.setErrorHandler(async (_error, _request, reply) => {
        applyNoStoreHeaders(reply);
        const statusCode = errorStatusCode(_error);
        if (statusCode === 413) {
          return sendError(reply, 413, "payload_too_large", "Request body exceeds 256KiB");
        }
        if (statusCode === 415) {
          return sendError(
            reply,
            415,
            "unsupported_media_type",
            "Content-Type must be application/json",
          );
        }
        if (statusCode === 400) {
          return sendError(reply, 400, "invalid_json", "Request body must be valid JSON");
        }
        return sendError(reply, 500, "internal_error", "External access request failed");
      });

      instance.setNotFoundHandler(async (_request, reply) => {
        applyNoStoreHeaders(reply);
        return sendError(reply, 404, "not_found", "Not found");
      });
    },
    { prefix: "/x" },
  );
}

/**
 * The single `/x` entrance judgment: credential failure, then kind, then
 * permission. An inbound webhook key (`ssxw`) is answered exactly like a wrong
 * key, and this runs again before a long poll's response leaves.
 */
async function resolveLinkGrant(
  options: ExternalAccessPublicRouteOptions,
  rawKey: string,
  requiredPermission?: ExternalAccessPermission,
): Promise<LinkGrantAccess> {
  const resolved = await options.grants.resolveGrant(rawKey);
  if (!resolved.ok) return { ok: false, status: resolved.status };
  if (resolved.grant.kind !== "link") return { ok: false, status: 401 };
  if (
    requiredPermission !== undefined
    && !resolved.grant.permissions.includes(requiredPermission)
  ) {
    return { ok: false, status: 403 };
  }
  return { ok: true, grant: resolved.grant };
}

async function holdForStatusChange(
  options: ExternalAccessPublicRouteOptions,
  grant: ExternalAccessGrant,
  requestId: string,
  first: ExternalRequestStatus,
  waitSeconds: number,
  reply: FastifyReply,
): Promise<ExternalRequestStatus> {
  const now = options.now ?? Date.now;
  const queue = new ExternalWakeQueue();
  const unsubscribeHub = options.eventHub.subscribe(
    grant.target_session_id,
    () => queue.signal(),
  );
  const unsubscribeSignal = options.replySignal.subscribe(
    grant.id,
    requestId,
    () => queue.signal(),
  );
  let clientClosed = false;
  const onClientClosed = () => {
    clientClosed = true;
    queue.close();
  };
  const raw = reply.raw as unknown as {
    once?: (event: string, listener: () => void) => void;
    off?: (event: string, listener: () => void) => void;
  };
  raw.once?.("close", onClientClosed);
  const deadline = now() + waitSeconds * 1000;
  let current = first;
  let previous = statusSnapshot(first);
  let lastReadAt = now();
  let changed = false;
  try {
    while (!clientClosed) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      // The wait between two database reads is never shorter than one second,
      // whatever signals arrive. This check runs before the pending check: a
      // signal that lands while a read is still running stays pending, and the
      // next read still waits out the rest of the gap.
      const untilNextRead =
        lastReadAt + STATUS_REREAD_MIN_INTERVAL_MS - now();
      if (untilNextRead > 0) {
        const gap = await queue.waitMinimumGap(
          Math.min(untilNextRead, remaining),
        );
        if (gap === "closed") {
          clientClosed = true;
          break;
        }
        continue;
      }
      if (!queue.hasPending()) {
        const wake = await queue.waitForSignal(Math.max(0, deadline - now()));
        if (wake !== "signaled") {
          if (wake === "closed") clientClosed = true;
          break;
        }
      }
      queue.consume();
      // The interval is measured between read starts, so a slow read does not
      // push the next one closer than a second to this one.
      const readStartedAt = now();
      const next = await options.inputService.readExternalRequestStatus(
        grant,
        requestId,
        { consumeRate: false },
      );
      lastReadAt = readStartedAt;
      if (!next.ok) return current;
      current = next.status;
      const snapshot = statusSnapshot(next.status);
      if (snapshot !== previous) {
        changed = true;
        previous = snapshot;
        break;
      }
      previous = snapshot;
    }
    if (!clientClosed && !changed &&
      now() - lastReadAt >= STATUS_REREAD_MIN_INTERVAL_MS) {
      const final = await options.inputService.readExternalRequestStatus(
        grant,
        requestId,
        { consumeRate: false },
      );
      if (final.ok) current = final.status;
    }
    return current;
  } finally {
    raw.off?.("close", onClientClosed);
    unsubscribeHub();
    unsubscribeSignal();
  }
}

function statusSnapshot(status: ExternalRequestStatus): string {
  return [
    status.status,
    status.outcome ?? "",
    String(status.replies.length),
    status.session.state,
  ].join("|");
}

function isTerminalStatus(status: ExternalRequestStatus["status"]): boolean {
  return status === "completed" || status === "failed";
}

function takeReadRate(
  options: ExternalAccessPublicRouteOptions,
  grantId: string,
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  return options.tokenBucket.take(
    `read:${grantId}`,
    options.readRatePerMinute ?? EXTERNAL_READ_RATE_PER_MINUTE,
  );
}

async function stopSession(
  options: ExternalAccessPublicRouteOptions,
  targetSessionId: string,
): Promise<ExternalAccessStopOutcome> {
  try {
    return await options.stopSession(targetSessionId);
  } catch {
    return "unavailable";
  }
}

async function readTargetDisplay(
  sql: SqlClient,
  sessionId: string,
): Promise<ExternalAccessTarget> {
  const rows = await sql<Array<{ display_name: string | null; agent_id: string | null }>>`
    SELECT display_name, agent_id FROM sessions WHERE session_id = ${sessionId}
  `;
  const row = rows[0];
  return {
    display_name: row?.display_name?.trim() || row?.agent_id?.trim() || null,
  };
}

function parseWaitSeconds(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d{1,2}$/.test(value)) return null;
  const seconds = Number(value);
  return seconds <= EXTERNAL_ACCESS_MAX_WAIT_SECONDS ? seconds : null;
}

function parseHistoryQuery(query: unknown): { before?: string; limit: number } | null {
  const record = typeof query === "object" && query !== null
    ? query as { before?: unknown; limit?: unknown }
    : {};
  const limit = record.limit;
  let limitValue = 50;
  if (limit !== undefined) {
    if (typeof limit !== "string" || !/^\d{1,3}$/.test(limit)) return null;
    limitValue = Number(limit);
    if (limitValue < 1 || limitValue > 50) return null;
  }
  const before = record.before;
  if (before === undefined) return { limit: limitValue };
  if (typeof before !== "string" || before.length === 0) return null;
  return { before, limit: limitValue };
}

function acceptsJson(accept: string | string[] | undefined): boolean {
  const value = Array.isArray(accept) ? accept.join(",") : accept;
  if (value === undefined) return false;
  return value
    .split(",")
    .some((part) => part.trim().split(";", 1)[0]?.trim() === "application/json");
}

function isVisibleHistoryItem(
  item: ExternalAccessHistoryItem,
): item is ExternalAccessHistoryItem & { kind: "user" | "assistant" } {
  return item.kind === "user" || item.kind === "assistant";
}

function applyNoStoreHeaders(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("referrer-policy", "no-referrer");
}

function sendAccessFailure(reply: FastifyReply, status: 401 | 403): FastifyReply {
  return status === 401
    ? sendError(reply, 401, "unauthorized", "Unauthorized")
    : sendError(reply, 403, "forbidden", "Action not permitted");
}

function invalidJsonError(message: string): Error {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 400;
  return error;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

function sendRateLimited(
  reply: FastifyReply,
  retryAfterSeconds: number,
): FastifyReply {
  reply.header("retry-after", String(Math.max(1, Math.ceil(retryAfterSeconds))));
  return sendError(reply, 429, "rate_limited", "Too many requests");
}

function errorStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

type WakeReason = "signaled" | "timeout" | "closed";
type GapReason = "timeout" | "closed";

/**
 * Signals the hold loop on a session event or a posted reply. A signal can wake
 * only a signal wait; the minimum-gap wait ignores it so two database reads
 * never happen closer than one second. A signal that arrives early stays
 * pending and is spent by the read after the gap.
 */
class ExternalWakeQueue {
  private pending = 0;
  private closed = false;
  private mode: "signal" | "gap" | null = null;
  private waiter: ((reason: WakeReason) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  signal(): void {
    if (this.closed) return;
    this.pending += 1;
    if (this.mode === "signal") this.waiter?.("signaled");
  }

  close(): void {
    this.closed = true;
    this.waiter?.("closed");
  }

  hasPending(): boolean {
    return this.pending > 0;
  }

  consume(): void {
    this.pending = 0;
  }

  /** Waits for a signal or the timeout; ignored signals stay pending. */
  async waitForSignal(ms: number): Promise<WakeReason> {
    if (this.closed) return "closed";
    if (this.pending > 0) return "signaled";
    return await this.wait("signal", ms);
  }

  /** Waits out the gap before the next read; only close ends it early. */
  async waitMinimumGap(ms: number): Promise<GapReason> {
    if (this.closed) return "closed";
    if (ms <= 0) return "timeout";
    return await this.wait("gap", ms) as GapReason;
  }

  private async wait(mode: "signal" | "gap", ms: number): Promise<WakeReason> {
    return await new Promise<WakeReason>((resolve) => {
      let settled = false;
      const finish = (reason: WakeReason) => {
        if (settled) return;
        settled = true;
        if (this.timer !== null) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        this.waiter = null;
        this.mode = null;
        resolve(reason);
      };
      this.mode = mode;
      this.waiter = finish;
      this.timer = setTimeout(() => finish("timeout"), Math.max(0, ms));
    });
  }

}

export type { FastifyRequest };
