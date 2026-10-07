import { z } from "zod";
import {
  sessionTools,
  errorResult,
  jsonResult,
  serializeSessionStoryTurnSummary,
} from "@soulstream/mcp-contract";
import { applyToolContentPolicy } from "./session_content_policy.js";
import { SessionConsumptionBoundary } from "./session_consumption_boundary.js";
import { readSessionFolders, sessionReadAdapter } from "./session_read_adapter.js";
import { parseSessionReadPeriod, serializeDate } from "./session_query_values.js";
import type { McpToolHandler } from "./types.js";

type SessionArgs<N extends keyof typeof sessionTools> = z.infer<
  z.ZodObject<typeof sessionTools[N]["config"]["inputSchema"]>
>;
const TOOL_TRUNCATE_DEFAULT = 500;

export const sessionListQueryHandlers = {
  list_sessions: async (options, args, context) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const repositories = await options.sessions.repositoryProvider();
      const runtime = { db: { ...sessionReadAdapter(repositories), getAllFolders: () => readSessionFolders(options.folders) } };
      const handler = async ({
        cursor,
        limit,
        search,
        folder_id,
        folder_name,
        node_id,
        node_name,
        since,
        until,
      }: SessionArgs<"list_sessions">) => {
        const parsedPeriod = parseSessionReadPeriod(since, until);
        if (parsedPeriod.error) return errorResult(parsedPeriod.error);
        const c = cursor ?? 0;
        const l = Math.min(limit ?? 20, 100);

        let resolvedFolderId = folder_id ?? null;
        if (folder_name && !folder_id) {
          const folders = await runtime.db.getAllFolders();
          const matched = folders.find((f) => f.name === folder_name);
          resolvedFolderId = matched ? matched.id : null;
        }
        const resolvedNodeId = node_id ?? node_name ?? null;

        const { sessions, total } = await runtime.db.listSessionsSummary({
          search: search ?? null,
          limit: l,
          offset: c,
          folderId: resolvedFolderId,
          nodeId: resolvedNodeId,
          ...(parsedPeriod.period === undefined ? {} : { period: parsedPeriod.period }),
        });
        const hasMore = c + l < total;
        return jsonResult({
          total,
          sessions: sessions.map((s) => ({
            session_id: s.session_id,
            display_name: s.display_name,
            status: s.status,
            session_type: s.session_type,
            created_at: serializeDate(s.created_at),
            updated_at: serializeDate(s.updated_at),
            event_count: s.event_count,
            caller_session_id: s.caller_session_id,
            away_summary: s.away_summary,
            agent_id: s.agent_id,
            node_id: s.node_id,
          })),
          next_cursor: hasMore ? c + l : null,
        });
      };
      return await handler(args as SessionArgs<"list_sessions">);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
  list_session_events: async (options, args, context) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const repositories = await options.sessions.repositoryProvider();
      const runtime = { db: { ...sessionReadAdapter(repositories) } };
      const consumptionBoundary = new SessionConsumptionBoundary(repositories.deliveries, context);
      const handler = async ({
        session_id,
        cursor,
        limit,
        tool_truncate_chars,
        event_types,
        tool_content,
        since,
        until,
      }: SessionArgs<"list_session_events">) => {
        const parsedPeriod = parseSessionReadPeriod(since, until);
        if (parsedPeriod.error) return errorResult(parsedPeriod.error);
        const session = await runtime.db.getSession(session_id);
        if (!session) return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
        const lim = limit ?? 20;
        const cur = cursor ?? 0;
        const fetched = parsedPeriod.period === undefined
          ? await runtime.db.readEvents(session_id, cur, lim + 1, event_types)
          : await runtime.db.readEvents(session_id, cur, lim + 1, event_types, parsedPeriod.period);
        const hasMore = fetched.length > lim;
        const events = hasMore ? fetched.slice(0, lim) : fetched;
        const totalEvents = await runtime.db.countEvents(session_id);
        const processed = events.map((ev) =>
          applyToolContentPolicy(
            ev,
            tool_content ?? "truncate",
            tool_truncate_chars ?? TOOL_TRUNCATE_DEFAULT,
          ),
        );
        const last = events[events.length - 1];
        const nextCursor = hasMore && last ? last.id : null;
        const result = jsonResult({
          session_id,
          total: totalEvents,
          events: processed,
          cursor: cur,
          limit: lim,
          truncated: hasMore,
          next_cursor: nextCursor,
          ...(nextCursor === null
            ? {}
            : {
                notice:
                  `${totalEvents}건 중 cursor ${cur}부터 ${events.length}건 표시. `
                  + `cursor=${nextCursor}로 계속 조회하세요.`,
              }),
        });
        return consumptionBoundary.commit(
          "list_session_events",
          result,
          [{ session, reflectedRevision: last?.id ?? null }],
        );
      };
      return await handler(args as SessionArgs<"list_session_events">);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
  get_session_turn_summaries: async (options, args, context) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const repositories = await options.sessions.repositoryProvider();
      const runtime = { db: { ...sessionReadAdapter(repositories) } };
      const consumptionBoundary = new SessionConsumptionBoundary(repositories.deliveries, context);
      const handler = async ({
        session_id,
        mode,
        turn_number,
        from_turn_number,
        to_turn_number,
        limit,
        since,
        until,
      }: SessionArgs<"get_session_turn_summaries">) => {
        const parsedPeriod = parseSessionReadPeriod(since, until);
        if (parsedPeriod.error) return errorResult(parsedPeriod.error);
        const session = await runtime.db.getSession(session_id);
        if (!session) return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
        if (mode === "count") {
          const counts = parsedPeriod.period === undefined
            ? await runtime.db.countTurnSummaries(session_id)
            : await runtime.db.countTurnSummaries(session_id, { period: parsedPeriod.period });
          const result = jsonResult({
            session_id,
            mode,
            total_count: counts.totalCount,
            digested_count: counts.digestedCount,
            undigested_count: counts.undigestedCount,
          });
          return consumptionBoundary.commit("get_session_turn_summaries", result, []);
        }
        if (mode === "index") {
          if (turn_number === undefined) return errorResult("index 모드에는 turn_number가 필요합니다.");
          const summaries = parsedPeriod.period === undefined
            ? await runtime.db.loadTurnSummaryRange(session_id, turn_number, turn_number, 1)
            : await runtime.db.loadTurnSummaryRange(session_id, turn_number, turn_number, 1, { period: parsedPeriod.period });
          const summary = summaries[0] ?? null;
          const result = jsonResult({
            session_id,
            mode,
            turn_number,
            summary: summary ? serializeSessionStoryTurnSummary(summary) : null,
          });
          return consumptionBoundary.commit(
            "get_session_turn_summaries",
            result,
            [{ session, reflectedRevision: summary?.eventId ?? null }],
          );
        }
        if (from_turn_number === undefined) return errorResult("range 모드에는 from_turn_number가 필요합니다.");
        if (to_turn_number !== undefined && to_turn_number < from_turn_number) {
          return errorResult("to_turn_number는 from_turn_number보다 작을 수 없습니다.");
        }
        const pageLimit = limit ?? 50;
        const fetched = parsedPeriod.period === undefined
          ? await runtime.db.loadTurnSummaryRange(session_id, from_turn_number, to_turn_number ?? null, pageLimit + 1)
          : await runtime.db.loadTurnSummaryRange(session_id, from_turn_number, to_turn_number ?? null, pageLimit + 1, { period: parsedPeriod.period });
        const hasMore = fetched.length > pageLimit;
        const summaries = hasMore ? fetched.slice(0, pageLimit) : fetched;
        const result = jsonResult({
          session_id,
          mode,
          from_turn_number,
          to_turn_number: to_turn_number ?? null,
          limit: pageLimit,
          summaries: summaries.map(serializeSessionStoryTurnSummary),
          has_more: hasMore,
          next_from_turn_number: hasMore ? fetched[pageLimit]?.turnNumber ?? null : null,
        });
        return consumptionBoundary.commit(
          "get_session_turn_summaries",
          result,
          [{ session, reflectedRevision: summaries[summaries.length - 1]?.eventId ?? null }],
        );
      };
      return await handler(args as SessionArgs<"get_session_turn_summaries">);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
} satisfies Record<string, McpToolHandler>;
