import {
  UI_EVENT_ENTRIES,
  UI_EVENT_TARGET_KINDS,
  UI_EVENT_TYPES,
  type UiEventAttrValue,
  type UiEventEntry,
  type UiEventTargetKind,
  type UiEventType,
} from "@soulstream/wire-schema/ui-events";
import { isUuid } from "../http/uuid.js";

export const UI_EVENT_MAX_BATCH = 50;

export const UI_EVENT_QUERY_TEXT_MAX = 500;

export const UI_EVENT_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export const UI_EVENT_CLIENT_KINDS = ["browser", "soul-app"] as const;
export type UiEventClientKind = (typeof UI_EVENT_CLIENT_KINDS)[number];

const STATUSES = ["ok", "error", "aborted"] as const;

type AttrSpec = {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  /** 값이 닫힌 집합인 키. */
  readonly enums?: Readonly<Record<string, readonly string[]>>;
  /** 정수여야 하는 키. */
  readonly integers?: readonly string[];
  /** 불리언이어야 하는 키. */
  readonly booleans?: readonly string[];
};

/**
 * 타입별 attrs allowlist.
 *
 * 여기에 없는 키가 들어오면 그 이벤트를 거절한다. 다만 이 검사만으로
 * "초안 원문 유출이 불가능하다"고 단정하지 않는다 — allowlist는 알려진 키만 막는다.
 * 원문을 싣지 않는 1차 근거는 계측 코드가 길이만 만든다는 사실이다.
 */
export const UI_EVENT_ATTRS: Readonly<Record<UiEventType, AttrSpec>> = {
  view_open: { required: [], optional: [] },
  search_submit: {
    required: ["queryText", "trigger"],
    optional: ["searchSessionId", "scope"],
    enums: { trigger: ["typing", "filter", "submit"] },
  },
  search_result: {
    required: ["status", "durationMs"],
    optional: ["resultCount", "errorCode"],
    enums: { status: STATUSES },
    integers: ["durationMs", "resultCount"],
  },
  search_result_open: {
    required: ["rank"],
    optional: ["resultKind"],
    integers: ["rank"],
  },
  notification_open: {
    required: ["surface"],
    optional: ["navigated"],
    enums: { surface: ["browser_notification", "push", "feed_card", "my_turn"] },
    booleans: ["navigated"],
  },
  compose_start: { required: [], optional: ["mode"] },
  compose_submit: {
    required: ["draftLength", "mode"],
    optional: [],
    integers: ["draftLength"],
  },
  compose_result: {
    required: ["status", "durationMs"],
    optional: ["errorCode", "sessionEventId"],
    enums: { status: STATUSES },
    integers: ["durationMs", "sessionEventId"],
  },
  compose_abandon: {
    required: ["draftPresent", "draftLength"],
    optional: ["reason"],
    integers: ["draftLength"],
    booleans: ["draftPresent"],
  },
  compose_resume: {
    required: ["draftPresent", "draftLength"],
    optional: [],
    integers: ["draftLength"],
    booleans: ["draftPresent"],
  },
  app_active: { required: [], optional: ["reason"] },
  app_inactive: {
    required: [],
    optional: ["reason"],
    enums: { reason: ["hidden", "pagehide", "background"] },
  },
  action_start: { required: ["action"], optional: [] },
  action_end: {
    required: ["action", "status", "durationMs"],
    optional: ["errorCode"],
    enums: { status: STATUSES },
    integers: ["durationMs"],
  },
};

/** flowId가 반드시 있어야 하는 계열 — search / compose / action 전부. */
export const UI_EVENT_FLOW_REQUIRED: ReadonlySet<UiEventType> = new Set<UiEventType>([
  "search_submit",
  "search_result",
  "search_result_open",
  "compose_start",
  "compose_submit",
  "compose_result",
  "compose_abandon",
  "compose_resume",
  "action_start",
  "action_end",
]);

export type UiEventTargetRef = {
  readonly kind: UiEventTargetKind;
  readonly id: string;
};

export type UiEventRejection = {
  readonly eventId: string;
  readonly reason: string;
};

/** 검증을 통과해 저장 가능한 형태. 서버가 채우는 필드는 여기 없다. */
export type NormalizedUiEvent = {
  readonly eventId: string;
  readonly seq: number;
  readonly occurredAt: Date;
  readonly type: UiEventType;
  readonly targetKind: UiEventTargetKind | null;
  readonly targetId: string | null;
  readonly fromKind: UiEventTargetKind | null;
  readonly fromId: string | null;
  readonly entry: UiEventEntry | null;
  readonly flowId: string | null;
  readonly attrs: Record<string, UiEventAttrValue>;
};

export function isUiEventType(value: unknown): value is UiEventType {
  return typeof value === "string" && (UI_EVENT_TYPES as readonly string[]).includes(value);
}

export function isUiEventTargetKind(value: unknown): value is UiEventTargetKind {
  return typeof value === "string" &&
    (UI_EVENT_TARGET_KINDS as readonly string[]).includes(value);
}

export function isUiEventEntry(value: unknown): value is UiEventEntry {
  return typeof value === "string" && (UI_EVENT_ENTRIES as readonly string[]).includes(value);
}

export type UiEventValidation =
  | { readonly ok: true; readonly value: NormalizedUiEvent }
  | { readonly ok: false; readonly reason: string };

/**
 * 이벤트 1건을 검증한다. 거절은 **이벤트 단위**다 — 한 건이 나쁘다고 배치 전체를
 * 되돌리면 클라이언트가 영구 재시도 루프에 갇힌다.
 *
 * @param receivedAtMs 서버 수신 시각. 클라이언트 시계 파손 판정에 쓴다.
 */
export function validateUiEvent(raw: unknown, receivedAtMs: number): UiEventValidation {
  if (!isRecord(raw)) return fail("event_not_object");

  const eventId = raw.eventId;
  if (!isUuid(eventId)) return fail("invalid_event_id");

  if (!isUiEventType(raw.type)) return fail("unknown_type");
  const type = raw.type;

  const seq = raw.seq;
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) return fail("invalid_seq");

  if (typeof raw.occurredAt !== "string") return fail("invalid_occurred_at");
  const occurredAt = new Date(raw.occurredAt);
  const occurredAtMs = occurredAt.getTime();
  if (!Number.isFinite(occurredAtMs)) return fail("invalid_occurred_at");
  if (occurredAtMs - receivedAtMs > UI_EVENT_FUTURE_TOLERANCE_MS) return fail("occurred_at_future");

  const target = parseRef(raw.target);
  if (target === "invalid") return fail("invalid_target");
  const from = parseRef(raw.from);
  if (from === "invalid") return fail("invalid_from");

  let entry: UiEventEntry | null = null;
  if (raw.entry !== undefined && raw.entry !== null) {
    if (!isUiEventEntry(raw.entry)) return fail("unknown_entry");
    entry = raw.entry;
  }

  let flowId: string | null = null;
  if (raw.flowId !== undefined && raw.flowId !== null) {
    if (typeof raw.flowId !== "string" || raw.flowId.length === 0 || raw.flowId.length > 200) {
      return fail("invalid_flow_id");
    }
    flowId = raw.flowId;
  }
  if (flowId === null && UI_EVENT_FLOW_REQUIRED.has(type)) return fail("missing_flow_id");

  const attrsResult = validateAttrs(type, raw.attrs);
  if (!attrsResult.ok) return attrsResult;

  return {
    ok: true,
    value: {
      eventId,
      seq: seq as number,
      occurredAt,
      type,
      targetKind: target?.kind ?? null,
      targetId: target?.id ?? null,
      fromKind: from?.kind ?? null,
      fromId: from?.id ?? null,
      entry,
      flowId,
      attrs: attrsResult.value,
    },
  };
}

type AttrsValidation =
  | { readonly ok: true; readonly value: Record<string, UiEventAttrValue> }
  | { readonly ok: false; readonly reason: string };

function validateAttrs(type: UiEventType, raw: unknown): AttrsValidation {
  const spec = UI_EVENT_ATTRS[type];
  if (raw === undefined || raw === null) {
    return spec.required.length === 0
      ? { ok: true, value: {} }
      : { ok: false, reason: `missing_attr:${spec.required[0]}` };
  }
  if (!isRecord(raw)) return { ok: false, reason: "attrs_not_object" };

  const allowed = new Set([...spec.required, ...spec.optional]);
  const out: Record<string, UiEventAttrValue> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    // allowlist 밖의 키는 저장하지 않고 이벤트를 거절한다. 조용히 버리면
    // 클라이언트가 보내고 있다는 사실 자체를 아무도 모르게 된다.
    if (!allowed.has(key)) return { ok: false, reason: `unknown_attr:${key}` };

    const enumValues = spec.enums?.[key];
    if (enumValues !== undefined) {
      if (typeof value !== "string" || !enumValues.includes(value)) {
        return { ok: false, reason: `invalid_attr:${key}` };
      }
      out[key] = value;
    } else if (spec.integers?.includes(key)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        return { ok: false, reason: `invalid_attr:${key}` };
      }
      out[key] = value;
    } else if (spec.booleans?.includes(key)) {
      if (typeof value !== "boolean") return { ok: false, reason: `invalid_attr:${key}` };
      out[key] = value;
    } else {
      if (typeof value !== "string") return { ok: false, reason: `invalid_attr:${key}` };
      // 검색어만 길이를 자른다. 거절하지 않는 이유는 긴 검색어도 사실이기 때문이다.
      out[key] = key === "queryText" ? value.slice(0, UI_EVENT_QUERY_TEXT_MAX) : value;
    }
  }

  for (const key of spec.required) {
    if (!(key in out)) return { ok: false, reason: `missing_attr:${key}` };
  }
  return { ok: true, value: out };
}

function parseRef(raw: unknown): UiEventTargetRef | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return "invalid";
  if (!isUiEventTargetKind(raw.kind)) return "invalid";
  if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 400) return "invalid";
  return { kind: raw.kind, id: raw.id };
}

function fail(reason: string): UiEventValidation {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
