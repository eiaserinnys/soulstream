import type { SqlClient } from "../control_plane/control_plane_types.js";

/**
 * External replies posted by the target agent (design 2.3, 2.5, 3.3).
 *
 * Only the agent of the target session posts replies, and only to requests it
 * received. Completion is decided by the explicit final reply and nothing else.
 * Grant revocation and expiry are not re-checked: a reply posted after
 * revocation is still recorded, because admitted work is not cancelled by the
 * link's lifetime (design 3.3).
 */

export const EXTERNAL_REPLY_TEXT_MAX_LENGTH = 65_536;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface WriteExternalReplyInput {
  callerSessionId: string;
  requestHandle: string;
  text?: string;
  final: boolean;
}

export type ExternalReplyWriteErrorCode =
  | "invalid_request_handle"
  | "external_request_not_found"
  | "external_request_closed"
  | "reply_text_required"
  | "reply_text_too_long"
  | "external_reply_write_failed";

export type WriteExternalReplyResult =
  | {
    ok: true;
    reply_id: string;
    request_handle: string;
    final: boolean;
    at: string;
  }
  | { ok: false; reason: ExternalReplyWriteErrorCode };

export interface ExternalReplyLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

interface ExternalInputReceiptTargetRow {
  target_session_id: string;
}

interface InsertedReplyRow {
  id: string;
  created_at: Date | string;
}

type TransactionOutcome =
  | {
    ok: true;
    reply_id: string;
    request_handle: string;
    final: boolean;
    at: string;
  }
  | { ok: false; reason: ExternalReplyWriteErrorCode };

export async function writeExternalReply(
  sql: SqlClient,
  input: WriteExternalReplyInput,
  logger?: ExternalReplyLogger,
): Promise<WriteExternalReplyResult> {
  const handle = parseRequestHandle(input.requestHandle);
  if (handle === null) return { ok: false, reason: "invalid_request_handle" };

  const text = input.text ?? "";
  if (text.length > EXTERNAL_REPLY_TEXT_MAX_LENGTH) {
    return { ok: false, reason: "reply_text_too_long" };
  }
  const hasText = text.trim().length > 0;
  if (!input.final && !hasText) return { ok: false, reason: "reply_text_required" };
  // A close without an answer still records one final row with empty text.
  const storedText = hasText ? text : "";

  try {
    return await sql.begin(async (tx): Promise<TransactionOutcome> => {
      // Serialize replies of one request on its receipt row: a concurrent final
      // reply either waits here or loses to the partial unique index below.
      const receipts = await tx<ExternalInputReceiptTargetRow[]>`
        SELECT target_session_id FROM external_input_receipts
        WHERE grant_id = ${handle.grantId} AND request_id = ${handle.requestId}
        FOR UPDATE
      `;
      const receipt = receipts[0];
      if (receipt === undefined
        || receipt.target_session_id !== input.callerSessionId) {
        // Same code for both: never reveal whether another session's request exists.
        return { ok: false, reason: "external_request_not_found" };
      }
      const closed = await tx`
        SELECT 1 FROM external_replies
        WHERE grant_id = ${handle.grantId}
          AND request_id = ${handle.requestId}
          AND final
      `;
      if (closed.length > 0) return { ok: false, reason: "external_request_closed" };
      const inserted = await tx<InsertedReplyRow[]>`
        INSERT INTO external_replies (grant_id, request_id, session_id, text, final)
        VALUES (
          ${handle.grantId}, ${handle.requestId}, ${input.callerSessionId},
          ${storedText}, ${input.final}
        )
        RETURNING id, created_at
      `;
      const row = inserted[0]!;
      return {
        ok: true,
        reply_id: row.id,
        request_handle: input.requestHandle,
        final: input.final,
        at: isoString(row.created_at),
      };
    });
  } catch (error) {
    if (sqlErrorCode(error) === "23505") {
      return { ok: false, reason: "external_request_closed" };
    }
    // The reply text is never logged; only the identity and the error class.
    logger?.warn(
      {
        grant_id: handle.grantId,
        request_id: handle.requestId,
        error_class: sqlErrorCode(error)
          ?? (error instanceof Error ? error.name : "unknown"),
      },
      "External reply write failed",
    );
    return { ok: false, reason: "external_reply_write_failed" };
  }
}

/** `<grant_id>:<request_id>` split at the first colon. */
function parseRequestHandle(
  handle: string,
): { grantId: string; requestId: string } | null {
  const separator = handle.indexOf(":");
  if (separator < 0) return null;
  const grantId = handle.slice(0, separator);
  const requestId = handle.slice(separator + 1);
  if (!UUID_PATTERN.test(grantId) || requestId.length === 0) return null;
  return { grantId, requestId };
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sqlErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
