import { errorResult, jsonResult, sessionTools } from "@soulstream/mcp-contract";
import { summarizeTurnUsage } from "./turn_usage_summary.js";
import { parseOffsetTimestamp } from "./session_query_values.js";
import type { McpToolHandler } from "./types.js";

const MAX_PERIOD_MS = 31 * 24 * 60 * 60 * 1000;

export const turnUsageHandlers = {
  list_turn_usage: async (options, args) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const sessionId = typeof args.session_id === "string" ? args.session_id : undefined;
      const sinceText = typeof args.since === "string" ? args.since : undefined;
      if (!sessionId && sinceText === undefined) {
        return errorResult("session_id 또는 since 중 하나를 지정해야 합니다.");
      }

      let since: Date | undefined;
      if (sinceText !== undefined) {
        const parsedSince = parseOffsetTimestamp(sinceText);
        if (!parsedSince) {
          return errorResult(`since는 오프셋이 명시된 ISO 8601 시각이어야 합니다: ${sinceText}`);
        }
        since = parsedSince;
      }
      const untilText = typeof args.until === "string" ? args.until : undefined;
      const until = untilText === undefined ? new Date() : parseOffsetTimestamp(untilText);
      if (!until) {
        return errorResult(`until은 오프셋이 명시된 ISO 8601 시각이어야 합니다: ${untilText}`);
      }
      if (since && since.getTime() >= until.getTime()) {
        return errorResult("since는 until보다 앞서야 합니다.");
      }
      if (!sessionId && since && until.getTime() - since.getTime() > MAX_PERIOD_MS) {
        return errorResult("기간 조회는 31일 이하여야 합니다.");
      }

      const cursor = typeof args.cursor === "number" ? args.cursor : 0;
      const limit = typeof args.limit === "number" ? args.limit : 100;
      const repositories = await options.sessions.repositoryProvider();
      const page = await repositories.eventReads.listTurnUsage({
        sessionId,
        since,
        until,
        cursor,
        limit,
      });

      const sessions: Record<string, Record<string, string>> = {};
      for (const row of page.rows) {
        const metadata: Record<string, string> = {};
        if (row.name !== undefined && row.name !== null) metadata.name = row.name;
        if (row.agent_id !== undefined && row.agent_id !== null) metadata.agent_id = row.agent_id;
        if (row.node_id !== undefined && row.node_id !== null) metadata.node_id = row.node_id;
        if (row.model_preset !== undefined && row.model_preset !== null) metadata.model_preset = row.model_preset;
        if (row.session_created_at !== undefined && row.session_created_at !== null) {
          metadata.created_at = toIsoString(row.session_created_at);
        }
        sessions[row.session_id] = metadata;
      }

      return jsonResult({
        since: since?.toISOString() ?? null,
        until: until.toISOString(),
        session_id: sessionId ?? null,
        total: page.total,
        cursor,
        limit,
        next_cursor: cursor + limit < page.total ? cursor + limit : null,
        sessions,
        turns: page.rows.map((row) => ({
          session_id: row.session_id,
          event_id: row.event_id,
          at: toIsoString(row.at),
          kind: row.kind,
          ...(row.model === undefined ? {} : { model: row.model }),
          ...(row.input_tokens === undefined ? {} : { input_tokens: row.input_tokens }),
          ...(row.cached_input_tokens === undefined ? {} : { cached_input_tokens: row.cached_input_tokens }),
          ...(row.cache_write_tokens === undefined ? {} : { cache_write_tokens: row.cache_write_tokens }),
          ...(row.output_tokens === undefined ? {} : { output_tokens: row.output_tokens }),
          ...(row.cost_usd === undefined ? {} : { cost_usd: row.cost_usd }),
          ...(row.first_call_input_tokens === undefined ? {} : { first_call_input_tokens: row.first_call_input_tokens }),
          ...(row.first_call_cached_tokens === undefined ? {} : { first_call_cached_tokens: row.first_call_cached_tokens }),
          ...(row.injection_chars === undefined ? {} : { injection_chars: row.injection_chars }),
          ...(row.kind !== "no_usage" || row.ended === undefined ? {} : { ended: row.ended }),
          ...(row.kind !== "no_usage" || row.tool_calls === undefined ? {} : { tool_calls: row.tool_calls }),
        })),
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },

  summarize_turn_usage: async (options, args) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const sinceText = typeof args.since === "string" ? args.since : "";
      const since = parseOffsetTimestamp(sinceText);
      if (!since) {
        return errorResult(`since는 오프셋이 명시된 ISO 8601 시각이어야 합니다: ${sinceText}`);
      }
      const untilText = typeof args.until === "string" ? args.until : undefined;
      const until = untilText === undefined ? new Date() : parseOffsetTimestamp(untilText);
      if (!until) {
        return errorResult(`until은 오프셋이 명시된 ISO 8601 시각이어야 합니다: ${untilText}`);
      }
      if (since.getTime() >= until.getTime()) {
        return errorResult("since는 until보다 앞서야 합니다.");
      }
      if (until.getTime() - since.getTime() > MAX_PERIOD_MS) {
        return errorResult("기간 조회는 31일 이하여야 합니다.");
      }

      const repositories = await options.sessions.repositoryProvider();
      const rows = await repositories.eventReads.summarizeTurnUsage({ since, until });
      return jsonResult({
        since: since.toISOString(),
        until: until.toISOString(),
        ...summarizeTurnUsage(rows, since.toISOString(), until.toISOString()),
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
} satisfies Record<"list_turn_usage" | "summarize_turn_usage", McpToolHandler>;

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
