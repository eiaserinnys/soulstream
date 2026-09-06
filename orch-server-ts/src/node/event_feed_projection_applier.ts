import type {
  PendingAttention,
  SessionFeedDelta,
  SessionNotice,
} from "../session/session_feed_contract.js";
import type {
  EventFeedProjectionApplier,
  EventIngressQuerySql,
} from "./event_ingress_repository.js";
import type { EventIngressEnvelope } from "./event_ingress_types.js";

const COMPACT_INPUT_MAX_BYTES = 16 * 1024;
const NOTICE_BODY_MAX_CODEPOINTS = 200;
const PERMISSION_TTL_MS = 10 * 60_000;
const STORED_NOTICE_LIMIT = 8;

type AttentionMutation =
  | { readonly kind: "upsert"; readonly attention: PendingAttention }
  | { readonly kind: "remove"; readonly attentionId: string }
  | { readonly kind: "clear_all" }
  | { readonly kind: "none" };

export type EventFeedProjectionApplication = SessionFeedDelta & {
  readonly updated_at: string;
};

export const applyEventFeedProjection: EventFeedProjectionApplier = async (
  sql,
  input,
) => {
  if (
    input.envelope.event_type === "session_ended" &&
    input.sessionEffectApplication?.applied === false
  ) return null;
  const attention = attentionMutation(input.envelope, input.eventId);
  const notice = sessionNotice(input.envelope, input.eventId, attention);
  if (attention.kind === "none" && notice === null) return null;

  const pendingDelta = await applyAttentionMutation(
    sql,
    input.envelope.session_id,
    input.eventId,
    input.envelope.created_at,
    attention,
  );
  if (notice !== null) {
    await appendNotice(sql, notice);
  }
  await sql`
    UPDATE sessions
    SET updated_at = GREATEST(updated_at, ${new Date(input.envelope.created_at)})
    WHERE session_id = ${input.envelope.session_id}
  `;

  return {
    updated_at: new Date(input.envelope.created_at).toISOString(),
    ...(attention.kind === "none"
      ? {}
      : {
          attention_revision: input.eventId,
          pending_attentions_delta: pendingDelta,
        }),
    ...(notice === null
      ? {}
      : {
          notices: [notice],
          notification_watermark: input.eventId,
        }),
  };
};

export function attentionMutation(
  envelope: EventIngressEnvelope,
  eventId: number,
): AttentionMutation {
  const payload = recordValue(envelope.payload) ?? {};
  const sessionId = envelope.session_id;
  const requestedAt = new Date(envelope.created_at).toISOString();

  if (envelope.event_type === "input_request") {
    const requestId = stringValue(payload.request_id, payload.requestId);
    if (!requestId) return { kind: "none" };
    const toolUseId = stringValue(payload.tool_use_id, payload.toolUseId);
    const questions = compactQuestions(payload.questions);
    const timeoutSec = positiveNumber(payload.timeout_sec ?? payload.timeoutSec);
    const requiresDetail = questions.value === undefined || questions.truncated;
    return {
      kind: "upsert",
      attention: {
        id: attentionId("input_request", requestId),
        sourceEventId: eventId,
        sessionId,
        kind: "input_request",
        requestedAt,
        title: "입력 요청",
        body: inputRequestBody(payload),
        requestId,
        ...(toolUseId ? { toolUseId } : {}),
        ...(questions.value === undefined ? {} : { questions: questions.value }),
        ...(timeoutSec === undefined ? {} : {
          timeoutSec,
          ...optionalExpiry(requestedAt, timeoutSec * 1_000),
        }),
        requiresDetail,
      },
    };
  }

  if (
    envelope.event_type === "input_request_expired" ||
    envelope.event_type === "input_request_responded"
  ) {
    const requestId = stringValue(payload.request_id, payload.requestId);
    return requestId
      ? { kind: "remove", attentionId: attentionId("input_request", requestId) }
      : { kind: "none" };
  }

  if (envelope.event_type === "tool_approval_requested") {
    const approvalId = stringValue(
      payload.approval_id,
      payload.approvalId,
      payload.tool_use_id,
      payload.toolUseId,
    );
    if (!approvalId) return { kind: "none" };
    const toolUseId = stringValue(payload.tool_use_id, payload.toolUseId);
    const toolName = truncateCodepoints(
      stringValue(payload.tool_name, payload.toolName) || "tool",
      NOTICE_BODY_MAX_CODEPOINTS,
    );
    const toolInput = compactToolInput(payload.tool_input ?? payload.toolInput);
    return {
      kind: "upsert",
      attention: {
        id: attentionId("tool_approval", approvalId),
        sourceEventId: eventId,
        sessionId,
        kind: "tool_approval",
        requestedAt,
        title: "도구 승인 요청",
        body: truncateCodepoints(toolName, NOTICE_BODY_MAX_CODEPOINTS),
        approvalId,
        ...(toolUseId ? { toolUseId } : {}),
        toolName,
        ...(toolInput.value === undefined ? {} : { toolInput: toolInput.value }),
        requiresDetail: toolInput.truncated,
      },
    };
  }

  if (envelope.event_type === "tool_approval_resolved") {
    const approvalId = stringValue(
      payload.approval_id,
      payload.approvalId,
      payload.tool_use_id,
      payload.toolUseId,
    );
    return approvalId
      ? { kind: "remove", attentionId: attentionId("tool_approval", approvalId) }
      : { kind: "none" };
  }

  if (
    envelope.event_type === "claude_runtime_mode_state" &&
    payload.mode === "plan" &&
    stringValue(payload.tool_name, payload.toolName) === "ExitPlanMode"
  ) {
    const toolUseId = stringValue(payload.tool_use_id, payload.toolUseId);
    const identity = toolUseId || String(eventId);
    if (payload.active === false) {
      return {
        kind: "upsert",
        attention: {
          id: attentionId("exit_plan_mode", identity),
          sourceEventId: eventId,
          sessionId,
          kind: "exit_plan_mode",
          requestedAt,
          title: "플랜 검토 요청",
          body: "ExitPlanMode",
          ...(toolUseId ? { toolUseId } : {}),
          requiresDetail: true,
        },
      };
    }
    return { kind: "remove", attentionId: attentionId("exit_plan_mode", identity) };
  }

  if (envelope.event_type === "claude_runtime_notification") {
    const notificationType = stringValue(
      payload.notification_type,
      payload.notificationType,
      payload.key,
    ).toLowerCase();
    if (notificationType !== "permission") return { kind: "none" };
    const toolUseId = stringValue(payload.tool_use_id, payload.toolUseId);
    const identity = toolUseId || stringValue(
      payload.notification_id,
      payload.notificationId,
    );
    if (!identity) return { kind: "none" };
    return {
      kind: "upsert",
      attention: {
        id: attentionId("permission", identity),
        sourceEventId: eventId,
        sessionId,
        kind: "permission",
        requestedAt,
        title: "권한 요청",
        body: truncateCodepoints(
          firstText(payload.message, payload.title) || "권한 승인이 필요합니다",
          NOTICE_BODY_MAX_CODEPOINTS,
        ),
        ...(toolUseId ? { toolUseId } : {}),
        expiresAt: new Date(Date.parse(requestedAt) + PERMISSION_TTL_MS).toISOString(),
        requiresDetail: true,
      },
    };
  }

  if (
    (envelope.event_type === "tool_start" || envelope.event_type === "tool_result") &&
    stringValue(payload.tool_name, payload.toolName) === "ExitPlanMode"
  ) {
    const toolUseId = stringValue(payload.tool_use_id, payload.toolUseId);
    return toolUseId
      ? { kind: "remove", attentionId: attentionId("exit_plan_mode", toolUseId) }
      : { kind: "none" };
  }

  if (envelope.event_type === "tool_start" || envelope.event_type === "tool_result") {
    const toolUseId = stringValue(payload.tool_use_id, payload.toolUseId);
    return toolUseId
      ? { kind: "remove", attentionId: attentionId("permission", toolUseId) }
      : { kind: "none" };
  }

  if (envelope.event_type === "session_ended") {
    return { kind: "clear_all" };
  }
  return { kind: "none" };
}

export function sessionNotice(
  envelope: EventIngressEnvelope,
  eventId: number,
  attention = attentionMutation(envelope, eventId),
): SessionNotice | null {
  const payload = recordValue(envelope.payload) ?? {};
  let kind: SessionNotice["kind"];
  let title: string;
  let body: string;
  if (envelope.event_type === "session_ended") {
    kind = "terminal";
    const status = stringValue(payload.status) || "completed";
    title = status === "error" ? "세션 오류" : "세션 완료";
    body = firstText(payload.last_assistant_text, payload.result, payload.message) || title;
  } else if (envelope.event_type === "error") {
    kind = "error";
    title = "세션 오류";
    body = firstText(payload.message) || title;
  } else if (envelope.event_type === "intervention_sent") {
    kind = "intervention";
    title = "새 메시지";
    body = firstText(payload.text) || title;
  } else if (envelope.event_type === "session_notification") {
    kind = "response_wait";
    title = "Soul Dashboard";
    body = firstText(payload.text) || title;
  } else if (envelope.event_type === "claude_runtime_notification") {
    kind = "runtime_notification";
    title = firstText(payload.title) || "런타임 알림";
    body = firstText(payload.message) || title;
  } else if (attention.kind === "upsert") {
    kind = "response_wait";
    title = attention.attention.title;
    body = attention.attention.body;
  } else {
    return null;
  }
  return {
    id: `${envelope.session_id}:${eventId}`,
    sourceEventId: eventId,
    sessionId: envelope.session_id,
    kind,
    title: truncateCodepoints(title, NOTICE_BODY_MAX_CODEPOINTS),
    body: truncateCodepoints(body, NOTICE_BODY_MAX_CODEPOINTS),
    createdAt: new Date(envelope.created_at).toISOString(),
  };
}

async function applyAttentionMutation(
  sql: EventIngressQuerySql,
  sessionId: string,
  eventId: number,
  createdAt: string,
  mutation: AttentionMutation,
): Promise<Record<
  string,
  { revision: number; value: PendingAttention | null }
>> {
  if (mutation.kind === "none") return {};
  const delta: Record<
    string,
    { revision: number; value: PendingAttention | null }
  > = {};
  if (mutation.kind === "upsert") {
    await sql`
      INSERT INTO session_pending_attentions (
        session_id, attention_id, source_event_id, projection, requested_at
      ) VALUES (
        ${sessionId}, ${mutation.attention.id}, ${eventId},
        ${sql.json(mutation.attention)}, ${new Date(createdAt)}
      )
      ON CONFLICT (session_id, attention_id) DO UPDATE
      SET source_event_id = EXCLUDED.source_event_id,
          projection = EXCLUDED.projection,
          requested_at = EXCLUDED.requested_at
      WHERE session_pending_attentions.source_event_id < EXCLUDED.source_event_id
    `;
    delta[mutation.attention.id] = {
      revision: eventId,
      value: mutation.attention,
    };
  } else if (mutation.kind === "remove") {
    await sql`
      DELETE FROM session_pending_attentions
      WHERE session_id = ${sessionId}
        AND attention_id = ${mutation.attentionId}
    `;
    delta[mutation.attentionId] = { revision: eventId, value: null };
  } else {
    const rows = await sql<Array<{ attention_id: string }>>`
      DELETE FROM session_pending_attentions
      WHERE session_id = ${sessionId}
      RETURNING attention_id
    `;
    for (const row of rows) {
      delta[row.attention_id] = { revision: eventId, value: null };
    }
  }
  await sql`
    INSERT INTO session_feed_state (session_id, attention_revision, updated_at)
    VALUES (${sessionId}, ${eventId}, ${new Date(createdAt)})
    ON CONFLICT (session_id) DO UPDATE
    SET attention_revision = GREATEST(
          session_feed_state.attention_revision,
          EXCLUDED.attention_revision
        ),
        updated_at = GREATEST(session_feed_state.updated_at, EXCLUDED.updated_at)
  `;
  return delta;
}

async function appendNotice(
  sql: EventIngressQuerySql,
  notice: SessionNotice,
): Promise<void> {
  const inserted = await sql<Array<{ source_event_id: number }>>`
    INSERT INTO session_feed_notices (
      session_id, source_event_id, projection, created_at
    ) VALUES (
      ${notice.sessionId}, ${notice.sourceEventId},
      ${sql.json(notice)}, ${new Date(notice.createdAt)}
    )
    ON CONFLICT (session_id, source_event_id) DO NOTHING
    RETURNING source_event_id
  `;
  if (inserted.length === 0) return;
  await sql`
    INSERT INTO session_feed_state (
      session_id, notification_watermark, notification_count, updated_at
    ) VALUES (
      ${notice.sessionId}, ${notice.sourceEventId}, 1, ${new Date(notice.createdAt)}
    )
    ON CONFLICT (session_id) DO UPDATE
    SET notification_watermark = GREATEST(
          session_feed_state.notification_watermark,
          EXCLUDED.notification_watermark
        ),
        notification_count = session_feed_state.notification_count + 1,
        updated_at = GREATEST(session_feed_state.updated_at, EXCLUDED.updated_at)
  `;
  await sql`
    DELETE FROM session_feed_notices
    WHERE session_id = ${notice.sessionId}
      AND source_event_id NOT IN (
        SELECT source_event_id
        FROM session_feed_notices
        WHERE session_id = ${notice.sessionId}
        ORDER BY source_event_id DESC
        LIMIT ${STORED_NOTICE_LIMIT}
      )
  `;
}

function attentionId(kind: PendingAttention["kind"], identity: string): string {
  return `${kind}:${identity}`;
}

function inputRequestBody(payload: Record<string, unknown>): string {
  if (Array.isArray(payload.questions)) {
    for (const value of payload.questions) {
      const question = recordValue(value);
      const text = firstText(question?.question, question?.header, value);
      if (text) return truncateCodepoints(text, NOTICE_BODY_MAX_CODEPOINTS);
    }
  }
  return truncateCodepoints(
    firstText(payload.prompt, payload.message, payload.title) || "응답이 필요합니다",
    NOTICE_BODY_MAX_CODEPOINTS,
  );
}

function optionalExpiry(
  requestedAt: string,
  ttlMs: number,
): { expiresAt?: string } {
  const expiresAt = new Date(Date.parse(requestedAt) + ttlMs);
  return Number.isFinite(expiresAt.getTime())
    ? { expiresAt: expiresAt.toISOString() }
    : {};
}

function compactQuestions(value: unknown): {
  value?: readonly Record<string, unknown>[];
  truncated: boolean;
} {
  if (!Array.isArray(value)) return { truncated: true };
  const questions = value.flatMap((item) => {
    const question = recordValue(item);
    if (question === null) return [];
    const projected: Record<string, unknown> = {};
    for (const key of ["question", "header", "multiSelect"]) {
      if (key in question) projected[key] = question[key];
    }
    if (Array.isArray(question.options)) {
      projected.options = question.options.flatMap((option) => {
        const record = recordValue(option);
        if (record === null) return [];
        return [{
          ...(typeof record.label === "string" ? { label: record.label } : {}),
          ...(typeof record.description === "string"
            ? { description: record.description }
            : {}),
        }];
      });
    }
    return [projected];
  });
  const truncated = questions.length !== value.length || jsonBytes(questions) > COMPACT_INPUT_MAX_BYTES;
  return truncated ? { truncated: true } : { value: questions, truncated: false };
}

function compactToolInput(value: unknown): {
  value?: Readonly<Record<string, unknown>>;
  truncated: boolean;
} {
  const record = recordValue(value);
  if (record === null) return { truncated: value !== undefined && value !== null };
  const projected: Record<string, unknown> = {};
  const keys = [
    "command", "cwd", "path", "paths", "url", "query", "plan",
    "description", "summary", "prompt", "question",
  ];
  for (const key of keys) {
    if (key in record) projected[key] = record[key];
  }
  const omitted = Object.keys(record).some((key) => !keys.includes(key));
  if (jsonBytes(projected) > COMPACT_INPUT_MAX_BYTES) {
    return { truncated: true };
  }
  return { value: projected, truncated: omitted };
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text.length > 0) return text;
  }
  return "";
}

function stringValue(...values: unknown[]): string {
  return firstText(...values);
}

function truncateCodepoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
