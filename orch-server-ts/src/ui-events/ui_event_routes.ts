import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  UI_EVENT_CLIENT_KINDS,
  UI_EVENT_MAX_BATCH,
  UI_EVENT_SCHEMA_VERSION,
  isUiEventTargetKind,
  validateUiEvent,
  type NormalizedUiEvent,
  type UiEventClientKind,
  type UiEventEntry,
  type UiEventRejection,
  type UiEventTargetKind,
  type UiEventType,
} from "./ui_event_contract.js";
import type { UiEventCollectionConfig } from "./ui_event_settings.js";

/** 인증에서 서버가 확정하는 신원. 클라이언트 본문은 이것을 덮을 수 없다. */
export type UiEventIdentity = {
  readonly email: string;
  readonly clientKind: UiEventClientKind;
};

export type UiEventIdentityResolver = (
  request: FastifyRequest,
) => Promise<UiEventIdentity | null> | UiEventIdentity | null;

/** 저장 직전 형태. 봉투 필드는 이벤트마다 붙어 다닌다. */
export type UiEventRow = NormalizedUiEvent & {
  readonly schemaVersion: string;
  readonly userEmail: string;
  readonly clientKind: UiEventClientKind;
  readonly installId: string;
  readonly clientSessionKey: string;
  readonly appVersion: string;
};

export type StoredUiEvent = {
  readonly eventId: string;
  readonly seq: number;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly clientKind: UiEventClientKind;
  readonly installId: string;
  readonly clientSessionKey: string;
  readonly appVersion: string;
  readonly type: UiEventType;
  readonly target: { readonly kind: UiEventTargetKind; readonly id: string } | null;
  readonly from: { readonly kind: UiEventTargetKind; readonly id: string } | null;
  readonly entry: UiEventEntry | null;
  readonly flowId: string | null;
  readonly attrs: Record<string, unknown>;
};

export type UiEventInstall = {
  readonly installId: string;
  readonly clientKind: UiEventClientKind;
  readonly appVersion: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly eventCount: number;
};

export type UiEventQuery = {
  readonly userEmail: string;
  readonly from: string;
  readonly to: string;
  readonly installId?: string;
  readonly clientKind?: UiEventClientKind;
  readonly targetKind?: UiEventTargetKind;
  readonly targetId?: string;
  readonly limit: number;
  readonly cursorOccurredAt?: string;
  readonly cursorEventId?: string;
};

export type UiEventRepository = {
  readonly readConfig: () => Promise<UiEventCollectionConfig>;
  /** 저장된 event_id만 돌려준다. 중복(ON CONFLICT)은 빠진다. */
  readonly insertBatch: (rows: readonly UiEventRow[]) => Promise<readonly string[]>;
  readonly query: (query: UiEventQuery) => Promise<readonly StoredUiEvent[]>;
  readonly listInstalls: (
    query: { readonly userEmail: string; readonly from: string; readonly to: string },
  ) => Promise<readonly UiEventInstall[]>;
  /** 30일 지난 행을 상한을 두고 지운다. 호출 주기는 호출자가 정한다. */
  readonly pruneExpired: () => Promise<number>;
};

export type UiEventRouteOptions = {
  readonly repository: UiEventRepository;
  readonly resolveIdentity: UiEventIdentityResolver;
  /** 같은 프로세스에서 보존 정리를 다시 돌리기까지의 최소 간격. 기본 1시간. */
  readonly pruneIntervalMs?: number;
  readonly now?: () => number;
  readonly onWarning?: (message: string, error: unknown) => void;
};

export const uiEventRouteAuthRequirements = {
  "POST /api/ui-events": true,
  "GET /api/ui-events": true,
  "GET /api/ui-events/config": true,
  "GET /api/ui-events/installs": true,
} as const;

const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_QUERY_LIMIT = 200;
const MAX_QUERY_LIMIT = 500;

export function registerUiEventRoutes(
  app: FastifyInstance,
  options: UiEventRouteOptions,
): void {
  const now = options.now ?? (() => Date.now());
  const pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  // 이 프로세스가 마지막으로 보존 정리를 돌린 시각. 스케줄러를 새로 만들지 않고
  // 수집 경로에 얹기 위한 최소 상태다.
  let lastPruneAtMs = 0;

  // 정적 경로를 동적 경로보다 먼저 등록한다(라우터 충돌 예방 관례).
  app.get("/api/ui-events/config", async (request, reply) => {
    const identity = await resolveOrReject(request, reply, options);
    if (identity === undefined) return reply;
    const config = await options.repository.readConfig();
    return reply.send({ ...config, schemaVersion: UI_EVENT_SCHEMA_VERSION });
  });

  app.get("/api/ui-events/installs", async (request, reply) => {
    const identity = await resolveOrReject(request, reply, options);
    if (identity === undefined) return reply;
    const range = parseRange(request.query);
    if (!range.ok) return reply.code(422).send({ detail: range.reason });
    const installs = await options.repository.listInstalls({
      userEmail: identity.email,
      from: range.from,
      to: range.to,
    });
    return reply.send({ installs });
  });

  app.get("/api/ui-events", async (request, reply) => {
    const identity = await resolveOrReject(request, reply, options);
    if (identity === undefined) return reply;
    const parsed = parseQuery(request.query, identity.email);
    if (!parsed.ok) return reply.code(422).send({ detail: parsed.reason });

    // limit+1을 읽어 다음 페이지 존재 여부를 판정한다.
    const rows = await options.repository.query({
      ...parsed.value,
      limit: parsed.value.limit + 1,
    });
    const hasMore = rows.length > parsed.value.limit;
    const events = hasMore ? rows.slice(0, parsed.value.limit) : rows;
    const last = events[events.length - 1];
    return reply.send({
      events,
      nextCursor: hasMore && last ? `${last.occurredAt}|${last.eventId}` : null,
    });
  });

  app.post("/api/ui-events", async (request, reply) => {
    const identity = await resolveOrReject(request, reply, options);
    if (identity === undefined) return reply;

    const config = await options.repository.readConfig();
    if (!config.enabled) {
      // 설정을 끈 것은 클라이언트 잘못이 아니다. 4xx로 에러 루프에 빠뜨리지 않는다.
      return reply.send({ accepted: 0, duplicates: 0, disabled: true, rejected: [] });
    }

    const envelope = parseEnvelope(request.body);
    if (!envelope.ok) {
      return reply.code(envelope.statusCode).send({ detail: envelope.reason });
    }

    const receivedAtMs = now();
    const rejected: UiEventRejection[] = [];
    const rows: UiEventRow[] = [];
    const seenEventIds = new Set<string>();

    for (const raw of envelope.value.events) {
      const result = validateUiEvent(raw, receivedAtMs);
      if (!result.ok) {
        rejected.push({ eventId: rawEventId(raw), reason: result.reason });
        continue;
      }
      // 같은 배치 안의 중복은 DB까지 갈 필요가 없다.
      if (seenEventIds.has(result.value.eventId)) continue;
      seenEventIds.add(result.value.eventId);
      rows.push({
        ...result.value,
        schemaVersion: UI_EVENT_SCHEMA_VERSION,
        userEmail: identity.email,
        clientKind: identity.clientKind,
        installId: envelope.value.installId,
        clientSessionKey: envelope.value.clientSessionKey,
        appVersion: envelope.value.appVersion,
      });
    }

    const inserted = rows.length === 0 ? [] : await options.repository.insertBatch(rows);
    void schedulePrune();

    return reply.send({
      accepted: inserted.length,
      duplicates: rows.length - inserted.length,
      rejected,
    });
  });

  /**
   * 보존 정리. 응답을 막지 않도록 await하지 않고, 실패해도 수집을 깨뜨리지 않는다.
   * 활동이 있을 때만 돌기 때문에 30일은 보장된 상한이 아니라 대략적인 정책이다.
   */
  async function schedulePrune(): Promise<void> {
    const current = now();
    if (current - lastPruneAtMs < pruneIntervalMs) return;
    lastPruneAtMs = current;
    try {
      await options.repository.pruneExpired();
    } catch (error) {
      options.onWarning?.("ui_events 보존 정리 실패", error);
    }
  }
}

async function resolveOrReject(
  request: FastifyRequest,
  reply: FastifyReply,
  options: UiEventRouteOptions,
): Promise<UiEventIdentity | undefined> {
  const identity = await options.resolveIdentity(request);
  if (identity === null || identity === undefined) {
    reply.code(401).send({ detail: "Authentication required for UI usage events" });
    return undefined;
  }
  return identity;
}

type EnvelopeResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly installId: string;
        readonly clientSessionKey: string;
        readonly appVersion: string;
        readonly events: readonly unknown[];
      };
    }
  | { readonly ok: false; readonly statusCode: number; readonly reason: string };

function parseEnvelope(body: unknown): EnvelopeResult {
  if (!isRecord(body)) return envelopeError(422, "Request body must be a JSON object");
  if (body.schemaVersion !== UI_EVENT_SCHEMA_VERSION) {
    return envelopeError(422, `schemaVersion must be ${UI_EVENT_SCHEMA_VERSION}`);
  }
  const installId = nonEmptyString(body.installId);
  if (installId === undefined) return envelopeError(422, "installId is required");
  const clientSessionKey = nonEmptyString(body.clientSessionKey);
  if (clientSessionKey === undefined) {
    return envelopeError(422, "clientSessionKey is required");
  }
  const appVersion = nonEmptyString(body.appVersion);
  if (appVersion === undefined) return envelopeError(422, "appVersion is required");
  if (!Array.isArray(body.events) || body.events.length === 0) {
    return envelopeError(422, "events must be a non-empty array");
  }
  if (body.events.length > UI_EVENT_MAX_BATCH) {
    return envelopeError(413, `events must contain at most ${UI_EVENT_MAX_BATCH} items`);
  }
  return {
    ok: true,
    value: { installId, clientSessionKey, appVersion, events: body.events },
  };
}

function envelopeError(statusCode: number, reason: string): EnvelopeResult {
  return { ok: false, statusCode, reason };
}

type RangeResult =
  | { readonly ok: true; readonly from: string; readonly to: string }
  | { readonly ok: false; readonly reason: string };

function parseRange(query: unknown): RangeResult {
  const record = isRecord(query) ? query : {};
  const from = isoTimestamp(record.from);
  if (from === undefined) return { ok: false, reason: "from must be an ISO timestamp" };
  const to = isoTimestamp(record.to);
  if (to === undefined) return { ok: false, reason: "to must be an ISO timestamp" };
  if (Date.parse(to) < Date.parse(from)) {
    return { ok: false, reason: "to must not precede from" };
  }
  return { ok: true, from, to };
}

type QueryResult =
  | { readonly ok: true; readonly value: UiEventQuery }
  | { readonly ok: false; readonly reason: string };

function parseQuery(query: unknown, userEmail: string): QueryResult {
  const range = parseRange(query);
  if (!range.ok) return { ok: false, reason: range.reason };
  const record = isRecord(query) ? query : {};

  let limit = DEFAULT_QUERY_LIMIT;
  if (record.limit !== undefined) {
    const parsed = Number(record.limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      return { ok: false, reason: "limit must be a positive integer" };
    }
    limit = Math.min(parsed, MAX_QUERY_LIMIT);
  }

  let clientKind: UiEventClientKind | undefined;
  if (record.clientKind !== undefined) {
    if (
      typeof record.clientKind !== "string" ||
      !(UI_EVENT_CLIENT_KINDS as readonly string[]).includes(record.clientKind)
    ) {
      return { ok: false, reason: "clientKind is not recognized" };
    }
    clientKind = record.clientKind as UiEventClientKind;
  }

  let targetKind: UiEventTargetKind | undefined;
  if (record.targetKind !== undefined) {
    if (!isUiEventTargetKind(record.targetKind)) {
      return { ok: false, reason: "targetKind is not recognized" };
    }
    targetKind = record.targetKind;
  }

  let cursorOccurredAt: string | undefined;
  let cursorEventId: string | undefined;
  if (record.cursor !== undefined) {
    if (typeof record.cursor !== "string") return { ok: false, reason: "cursor must be a string" };
    const separatorIndex = record.cursor.lastIndexOf("|");
    if (separatorIndex <= 0) return { ok: false, reason: "cursor is malformed" };
    const occurredAt = isoTimestamp(record.cursor.slice(0, separatorIndex));
    const eventId = nonEmptyString(record.cursor.slice(separatorIndex + 1));
    if (occurredAt === undefined || eventId === undefined) {
      return { ok: false, reason: "cursor is malformed" };
    }
    cursorOccurredAt = occurredAt;
    cursorEventId = eventId;
  }

  return {
    ok: true,
    value: {
      userEmail,
      from: range.from,
      to: range.to,
      limit,
      ...(nonEmptyString(record.installId) !== undefined
        ? { installId: nonEmptyString(record.installId) as string }
        : {}),
      ...(clientKind !== undefined ? { clientKind } : {}),
      ...(targetKind !== undefined ? { targetKind } : {}),
      ...(nonEmptyString(record.targetId) !== undefined
        ? { targetId: nonEmptyString(record.targetId) as string }
        : {}),
      ...(cursorOccurredAt !== undefined ? { cursorOccurredAt } : {}),
      ...(cursorEventId !== undefined ? { cursorEventId } : {}),
    },
  };
}

function rawEventId(raw: unknown): string {
  if (isRecord(raw) && typeof raw.eventId === "string") return raw.eventId;
  return "";
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
