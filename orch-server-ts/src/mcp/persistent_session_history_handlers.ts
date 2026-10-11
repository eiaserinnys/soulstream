import { errorResult, jsonResult, type PersistentSessionHistoryResult } from "@soulstream/mcp-contract";
import { SERVICE_CALLER } from "../auth/service_caller.js";
import { projectPersistentSessionHistoryEntry } from "../session/persistent_session_history_projection.js";
import { parseSessionReadPeriod } from "./session_query_values.js";
import type { McpToolHandler } from "./types.js";

export const persistentSessionHistoryHandlers = {
  list_persistent_session_history: async (options, args, context) => {
    if (context.principal !== "internal") return errorResult("internal_principal_required");
    const callerSessionId = context.callerSessionId?.trim();
    if (!callerSessionId || !options.resolveSessionOwner) {
      return errorResult("A trusted Soulstream caller session is required for persistent session history.");
    }
    if (!options.persistentSessionSettings) {
      return errorResult("Persistent session settings service is unavailable.");
    }

    try {
      const owner = await options.resolveSessionOwner(callerSessionId);
      if (!owner) return errorResult("The trusted caller session has no verified owner email for persistent session history.");

      const sessionId = typeof args.session_id === "string" ? args.session_id : callerSessionId;
      const period = parseSessionReadPeriod(args.since as string | undefined, args.until as string | undefined);
      if (period.error) return errorResult(period.error);
      if (!period.period) return errorResult("since와 until을 함께 지정해야 합니다.");

      const resource = await options.persistentSessionSettings.get(SERVICE_CALLER, sessionId, owner.ownerEmail);
      if (!resource.session.persistent) return errorResult("NOT_PERSISTENT: target session is not a persistent session.");
      if (!options.sessions) return errorResult("session MCP dependencies are required");

      const repositories = await options.sessions.repositoryProvider();
      const cursor = (args.cursor as number | undefined) ?? 0;
      const limit = (args.limit as number | undefined) ?? 20;
      const maxTextChars = (args.max_text_chars as number | undefined) ?? 2000;
      const page = await repositories.eventReads.readPersistentSessionHistory({
        sessionId,
        since: new Date(period.period.since),
        until: new Date(period.period.until),
        cursor,
        limit,
      });
      const entries = page.rows.map((row) => projectPersistentSessionHistoryEntry(row, maxTextChars));
      const result: PersistentSessionHistoryResult = {
        session_id: sessionId,
        display_name: resource.session.display_name,
        since: period.period.since,
        until: period.period.until,
        time_zone: "Asia/Seoul",
        entries,
        returned_count: entries.length,
        next_cursor: page.nextCursor,
      };
      return jsonResult(result);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
} satisfies Record<"list_persistent_session_history", McpToolHandler>;
