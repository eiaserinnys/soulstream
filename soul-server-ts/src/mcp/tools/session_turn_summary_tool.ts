import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { serializeSessionStoryTurnSummary } from
  "../../db/session_story_types.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import type { SessionQueryConsumptionBoundary } from
  "./session_query_consumption_boundary.js";

export function registerSessionTurnSummaryTool(
  server: McpServer,
  runtime: McpRuntime,
  consumptionBoundary: SessionQueryConsumptionBoundary,
): void {
  server.registerTool(
    "get_session_turn_summaries",
    {
      description:
        "세션 턴 요약을 개수(count), 단건(index), 범위(range) 모드로 조회한다.",
      inputSchema: {
        session_id: z.string(),
        mode: z.enum(["count", "index", "range"]),
        turn_number: z.number().int().positive().optional(),
        from_turn_number: z.number().int().positive().optional(),
        to_turn_number: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({
      session_id,
      mode,
      turn_number,
      from_turn_number,
      to_turn_number,
      limit,
    }) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      if (mode === "count") {
        const counts = await runtime.db.countTurnSummaries(session_id);
        const result = jsonResult({
          session_id,
          mode,
          total_count: counts.totalCount,
          digested_count: counts.digestedCount,
          undigested_count: counts.undigestedCount,
        });
        return consumptionBoundary.commit(
          "get_session_turn_summaries",
          result,
          [],
        );
      }
      if (mode === "index") {
        if (turn_number === undefined) {
          return errorResult("index 모드에는 turn_number가 필요합니다.");
        }
        const summaries = await runtime.db.loadTurnSummaryRange(
          session_id,
          turn_number,
          turn_number,
          1,
        );
        const summary = summaries[0] ?? null;
        const result = jsonResult({
          session_id,
          mode,
          turn_number,
          summary: summary
            ? serializeSessionStoryTurnSummary(summary)
            : null,
        });
        return consumptionBoundary.commit(
          "get_session_turn_summaries",
          result,
          [{ session, reflectedRevision: summary?.eventId ?? null }],
        );
      }
      if (from_turn_number === undefined) {
        return errorResult("range 모드에는 from_turn_number가 필요합니다.");
      }
      if (
        to_turn_number !== undefined &&
        to_turn_number < from_turn_number
      ) {
        return errorResult(
          "to_turn_number는 from_turn_number보다 작을 수 없습니다.",
        );
      }
      const pageLimit = limit ?? 50;
      const fetched = await runtime.db.loadTurnSummaryRange(
        session_id,
        from_turn_number,
        to_turn_number ?? null,
        pageLimit + 1,
      );
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
        next_from_turn_number: hasMore
          ? fetched[pageLimit]?.turnNumber ?? null
          : null,
      });
      return consumptionBoundary.commit(
        "get_session_turn_summaries",
        result,
        [{
          session,
          reflectedRevision: summaries[summaries.length - 1]?.eventId ?? null,
        }],
      );
    },
  );
}
