import type { SessionDB } from "../db/session_db.js";

type SessionListDb = Pick<SessionDB, "listSessionsSummary">;
type ListSessionsSummary = Awaited<ReturnType<SessionListDb["listSessionsSummary"]>>;

export interface ListSessionsParams {
  requestId: string;
}

export interface SessionsUpdateAck {
  type: "sessions_update";
  sessions: ListSessionsSummary["sessions"];
  total: number;
  requestId: string;
}

/**
 * Python `_handle_list_sessions` calls `get_all_sessions()` without paging.
 * TS exposes the paged summary query, so this boundary makes the dump cap explicit.
 */
const LIST_SESSIONS_HARD_LIMIT = 10_000;

export class SessionListCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionListCommandError";
  }
}

/**
 * Owns upstream list_sessions semantics.
 *
 * SessionDB owns the query implementation. This boundary owns the upstream
 * dump semantics around it: required DB dependency, whole-list hard limit,
 * default offset, and sessions_update wire payload construction.
 */
export class SessionListCommands {
  constructor(private readonly sessionDb?: SessionListDb) {}

  async listSessions(params: ListSessionsParams): Promise<SessionsUpdateAck> {
    if (!this.sessionDb) {
      throw new SessionListCommandError(
        "list_sessions handler requires session_db dependency — wire main.ts CommandDispatcher with SessionDB",
      );
    }

    const { sessions, total } = await this.sessionDb.listSessionsSummary({
      limit: LIST_SESSIONS_HARD_LIMIT,
      offset: 0,
    });
    return {
      type: "sessions_update",
      sessions,
      total,
      requestId: params.requestId,
    };
  }
}
