import { sessionTools } from "@soulstream/mcp-contract";
/**
 * session_query 도구 — Python `mcp_session_query.py` 정합 (키 호환).
 *
 * 모든 도구는 `SessionDB` 신규 메서드(`listSessionsSummary`, `readEvents` 등)에만 의존.
 * dashboard·MCP 양쪽 진입점이 같은 메서드를 호출하므로 정책 정본 단일 (design-principles §3).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { applyToolContentPolicy } from "./session_query_content_policy.js";
import { resolveEffectiveCallerSessionId } from "./caller_session.js";
import { searchSessionEvents } from "../../search/session_search.js";
import { buildSessionTurnExcerpt } from "../../context/session_turn_summary.js";
import {
  serializeSessionStoryTurnSummary,
  serializeSessionStoryView,
  type SessionStoryView,
} from
  "../../db/session_story_types.js";
import { SessionQueryConsumptionBoundary } from
  "./session_query_consumption_boundary.js";
import { registerSessionTurnSummaryToolLegacy } from
  "./session_turn_summary_tool.js";
import { registerSearchSessionsToolLegacy } from "./search_sessions.js";

const DEFAULT_DOWNLOAD_DIR = "/tmp/soulstream_sessions";
const TOOL_TRUNCATE_DEFAULT = 500;

export function registerSessionQueryToolsLegacy(
  server: McpServer,
  runtime: McpRuntime,
): void {
  const consumptionBoundary = new SessionQueryConsumptionBoundary(
    runtime.childCompletionConsumption,
  );
  registerSessionTurnSummaryToolLegacy(server, runtime, consumptionBoundary);
  server.registerTool(
    "list_sessions",
    sessionTools.list_sessions.config,
    async ({ cursor, limit, search, folder_id, folder_name, node_id, node_name }) => {
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
    },
  );

  server.registerTool(
    "list_session_events",
    sessionTools.list_session_events.config,
    async ({ session_id, cursor, limit, tool_truncate_chars, event_types, tool_content }) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      const lim = limit ?? 20;
      const cur = cursor ?? 0;
      // Python `mcp_session_query.list_session_events` 정합 — `limit + 1` 페치로 has_more 판정.
      // has_more=false면 next_cursor=null 반환 (마지막 페이지 명시). 이전 구현은 항상 마지막 id를
      // 박아 Codex CLI가 무한 fetch 반복하는 회로를 열어 두었다 (code-reviewer P1-A 정정).
      const fetched = await runtime.db.readEvents(
        session_id,
        cur,
        lim + 1,
        event_types,
      );
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
    },
  );

  server.registerTool(
    "get_session_event",
    sessionTools.get_session_event.config,
    async ({ session_id, event_id }) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      const ev = await runtime.db.readOneEvent(session_id, event_id);
      if (!ev) {
        return errorResult(
          `이벤트를 찾을 수 없습니다: session=${session_id}, event_id=${event_id}`,
        );
      }
      return consumptionBoundary.commit(
        "get_session_event",
        jsonResult({ id: ev.id, event: ev.payload }),
        [{ session, reflectedRevision: ev.id }],
      );
    },
  );

  server.registerTool(
    "get_session_story",
    sessionTools.get_session_story.config,
    async ({ session_id, include_highlight }) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      const story = await runtime.db.getSessionStory(session_id);
      const serialized = serializeSessionStoryView(story);
      const result = jsonResult({
        source: sessionStorySource(story),
        ...(include_highlight ? { highlight: serialized.highlight } : {}),
        narrative: serialized.narrative,
        unfolded_turn_summaries: serialized.unfolded_turn_summaries,
        narrative_through_event_id: serialized.narrative_through_event_id,
        fold_count: serialized.fold_count,
        updated_at: serialized.updated_at,
      });
      return consumptionBoundary.commit(
        "get_session_story",
        result,
        [{ session, reflectedRevision: session.last_event_id }],
      );
    },
  );

  server.registerTool(
    "get_session_highlight",
    sessionTools.get_session_highlight.config,
    async ({ session_id }) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      const story = await runtime.db.getSessionStory(session_id);
      const source = sessionStorySource(story);
      const result = source === "story"
        ? jsonResult({
            source,
            highlight: story.highlight,
            updated_at: story.updatedAt?.toISOString() ?? null,
          })
        : jsonResult({
            source,
            turn_summaries: story.unfoldedTurnSummaries.map(
              serializeSessionStoryTurnSummary,
            ),
          });
      return consumptionBoundary.commit(
        "get_session_highlight",
        result,
        [{ session, reflectedRevision: session.last_event_id }],
      );
    },
  );

  server.registerTool(
    "download_session_history",
    {
      description:
        "세션의 전체 이벤트 히스토리를 JSONL 파일로 저장. default dir /tmp/soulstream_sessions/.",
      inputSchema: {
        session_id: z.string(),
        output_dir: z.string().optional(),
      },
    },
    async ({ session_id, output_dir }) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      const outDir = output_dir ?? DEFAULT_DOWNLOAD_DIR;
      mkdirSync(outDir, { recursive: true });
      const filePath = join(outDir, `session_${session_id}.jsonl`);
      const rows = await runtime.db.streamEventsRaw(session_id);
      const lines = rows
        .map((r) => {
          let parsedPayload: unknown = {};
          try {
            parsedPayload = JSON.parse(r.payload_text);
          } catch {
            parsedPayload = {};
          }
          return JSON.stringify({
            id: r.id,
            event_type: r.event_type,
            event: parsedPayload,
          });
        })
        .join("\n");
      writeFileSync(
        filePath,
        lines.length > 0 ? `${lines}\n` : "",
        "utf-8",
      );
      const result = jsonResult({
        session_id,
        file_path: filePath,
        event_count: rows.length,
      });
      return consumptionBoundary.commit(
        "download_session_history",
        result,
        [{
          session,
          reflectedRevision: rows[rows.length - 1]?.id ?? null,
        }],
      );
    },
  );

  server.registerTool(
    "search_session_history",
    sessionTools.search_session_history.config,
    async ({
      query,
      session_ids,
      event_types,
      search_session_id,
      include_turn_summaries,
      include_highlight,
      include_story,
      top_k,
    }, extra) => {
      try {
        const requestSignal = AbortSignal.any([
          extra.signal,
          AbortSignal.timeout(4_800),
        ]);
        const callerSessionId = resolveEffectiveCallerSessionId(undefined);
        const excludeSessionIds = callerSessionId
          && !session_ids?.includes(callerSessionId)
          ? [callerSessionId]
          : undefined;
        const results = await searchSessionEvents(runtime.db, {
          query,
          sessionIds: session_ids ?? null,
          excludeSessionIds,
          eventTypes: event_types,
          searchSessionId: search_session_id,
          includeTurnSummaries: include_turn_summaries,
          includeHighlight: include_highlight,
          includeStory: include_story,
          limit: top_k ?? 10,
          signal: requestSignal,
        });
        assertRequestActive(requestSignal);
        const sessionIds = [...new Set(results.map((result) => result.session_id))];
        const metadata = await runtime.db.getSessionSearchMetadata(sessionIds);
        assertRequestActive(requestSignal);
        const enrichedResults = results.map((result) => {
          const sessionMetadata = metadata.get(result.session_id) ?? {
            turnCount: 0,
            hasTurnSummaries: false,
            hasStoryDigest: false,
            hasHighlight: false,
          };
          return {
            ...result,
            turn_count: sessionMetadata.turnCount,
            has_turn_summaries: sessionMetadata.hasTurnSummaries,
            has_story_digest: sessionMetadata.hasStoryDigest,
            has_highlight: sessionMetadata.hasHighlight,
          };
        });
        const observations = consumptionBoundary.enabled
          ? await buildSearchObservations(runtime, results)
          : [];
        assertRequestActive(requestSignal);
        return consumptionBoundary.commit(
          "search_session_history",
          jsonResult({ results: enrichedResults }),
          observations,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(msg);
      }
    },
  );

  registerSearchSessionsToolLegacy(server, runtime);

  server.registerTool(
    "get_session_summary",
    sessionTools.get_session_summary.config,
    async ({ session_id, max_response_chars }) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      const { totalEvents, turns } = await buildSessionTurnExcerpt(
        runtime.db,
        session_id,
        max_response_chars ?? 500,
      );
      const result = jsonResult({
        session_id,
        display_name: session.display_name,
        status: session.status,
        created_at: serializeDate(session.created_at),
        // code-reviewer P2-4: Python `mcp_session_query.get_session_summary` 응답에 포함되는
        // caller_session_id 누락 보강. 위임 세션 부모 식별자 wire 보존.
        caller_session_id: session.caller_session_id,
        total_events: totalEvents,
        turns,
      });
      return consumptionBoundary.commit(
        "get_session_summary",
        result,
        [{ session, reflectedRevision: session.last_event_id }],
      );
    },
  );
}

function assertRequestActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("session history search request was cancelled");
  }
}

function sessionStorySource(
  story: SessionStoryView,
): "story" | "turn_summaries" | "empty" {
  if (story.narrative !== null) return "story";
  return story.unfoldedTurnSummaries.length > 0 ? "turn_summaries" : "empty";
}

async function buildSearchObservations(
  runtime: McpRuntime,
  results: Array<{ session_id: string; event_id: number }>,
): Promise<Array<{
  session: NonNullable<Awaited<ReturnType<McpRuntime["db"]["getSession"]>>>;
  reflectedRevision: number;
}>> {
  const highestReflectedRevision = new Map<string, number>();
  for (const result of results) {
    highestReflectedRevision.set(
      result.session_id,
      Math.max(
        highestReflectedRevision.get(result.session_id) ?? 0,
        result.event_id,
      ),
    );
  }
  const observations = [];
  for (const [sessionId, reflectedRevision] of highestReflectedRevision) {
    const session = await runtime.db.getSession(sessionId);
    if (session) observations.push({ session, reflectedRevision });
  }
  return observations;
}

function serializeDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString();
}
