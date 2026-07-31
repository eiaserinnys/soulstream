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
import { searchSessionEvents } from "../../search/session_search.js";
import { buildSessionTurnExcerpt } from "../../context/session_turn_summary.js";
import {
  serializeSessionStoryTurnSummary,
  serializeSessionStoryView,
  type SessionStoryView,
} from
  "../../db/repositories/session_story_repository.js";
import { SessionQueryConsumptionBoundary } from
  "./session_query_consumption_boundary.js";
import { registerSessionTurnSummaryTool } from
  "./session_turn_summary_tool.js";

const DEFAULT_DOWNLOAD_DIR = "/tmp/soulstream_sessions";
const TOOL_TRUNCATE_DEFAULT = 500;

export function registerSessionQueryTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  const consumptionBoundary = new SessionQueryConsumptionBoundary(
    runtime.childCompletionConsumption,
  );
  registerSessionTurnSummaryTool(server, runtime, consumptionBoundary);
  server.registerTool(
    "list_sessions",
    {
      description:
        "세션 목록을 페이지네이션하여 조회한다. 경량 필드만 반환 (Python list_sessions 정합).",
      inputSchema: {
        cursor: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        search: z.string().optional(),
        folder_id: z.string().optional(),
        folder_name: z.string().optional(),
        node_id: z.string().optional(),
        node_name: z.string().optional(),
      },
    },
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
        })),
        next_cursor: hasMore ? c + l : null,
      });
    },
  );

  server.registerTool(
    "list_session_events",
    {
      description:
        "세션 이벤트 목록 페이지네이션. tool_content로 tool_use/tool_result 길이 제어 (Python 정합).",
      inputSchema: {
        session_id: z.string(),
        cursor: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        tool_truncate_chars: z
          .number()
          .int()
          .min(0)
          .default(TOOL_TRUNCATE_DEFAULT),
        event_types: z.array(z.string()).optional(),
        tool_content: z
          .enum(["truncate", "full", "omit"])
          .default("truncate"),
      },
    },
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
    {
      description: "특정 이벤트의 전문(truncation 없음)을 조회.",
      inputSchema: {
        session_id: z.string(),
        event_id: z.number().int().positive(),
      },
    },
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
    {
      description:
        "접힌 세션 줄거리와 아직 접히지 않은 턴 요약을 조회한다. 스토리가 없으면 저장된 턴 요약으로 폴백한다.",
      inputSchema: {
        session_id: z.string(),
        include_highlight: z.boolean().default(false),
      },
    },
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
    {
      description:
        "저장된 세션 하이라이트를 우선 조회하고, 스토리가 없으면 저장된 턴 요약으로 폴백한다.",
      inputSchema: {
        session_id: z.string(),
      },
    },
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
    {
      description:
        "이벤트 텍스트 검색 (BM25, Python SessionSearchEngine 정합). "
        + '툴 사용 기록은 event_types: ["tool_start","tool_result"]를 명시해 검색한다.',
      inputSchema: {
        query: z.string().min(1),
        session_ids: z.array(z.string()).optional(),
        event_types: z.array(z.string()).optional(),
        search_session_id: z.boolean().default(false),
        include_turn_summaries: z.boolean().default(false),
        include_highlight: z.boolean().default(false),
        include_story: z.boolean().default(false),
        top_k: z.number().int().min(1).max(100).default(10),
      },
    },
    async ({
      query,
      session_ids,
      event_types,
      search_session_id,
      include_turn_summaries,
      include_highlight,
      include_story,
      top_k,
    }) => {
      try {
        const results = await searchSessionEvents(runtime.db, {
          query,
          sessionIds: session_ids ?? null,
          eventTypes: event_types,
          searchSessionId: search_session_id,
          includeTurnSummaries: include_turn_summaries,
          includeHighlight: include_highlight,
          includeStory: include_story,
          limit: top_k ?? 10,
        });
        const sessionIds = [...new Set(results.map((result) => result.session_id))];
        const metadata = await runtime.db.getSessionSearchMetadata(sessionIds);
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

  server.registerTool(
    "get_session_summary",
    {
      description: "세션의 턴별 요약 (LLM 미사용, DB 이벤트 순회).",
      inputSchema: {
        session_id: z.string(),
        max_response_chars: z.number().int().min(0).default(500),
      },
    },
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

function applyToolContentPolicy(
  ev: { id: number; event_type: string; payload: Record<string, unknown>; created_at: Date },
  policy: "truncate" | "full" | "omit",
  truncateChars: number,
): Record<string, unknown> {
  const isToolEvent =
    ev.event_type === "tool_use" || ev.event_type === "tool_result";
  let payload: Record<string, unknown> | string = ev.payload;
  if (isToolEvent) {
    if (policy === "omit") {
      payload = "(omitted)";
    } else if (policy === "truncate") {
      const text = JSON.stringify(ev.payload);
      payload =
        text.length > truncateChars
          ? `${text.slice(0, truncateChars)}…(truncated)`
          : text;
    }
  }
  return {
    id: ev.id,
    event_type: ev.event_type,
    event: payload,
    created_at: ev.created_at instanceof Date ? ev.created_at.toISOString() : ev.created_at,
  };
}
