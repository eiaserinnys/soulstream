import { z } from "zod";
import { sessionTools, errorResult, jsonResult, serializeSessionStoryView, serializeSessionStoryTurnSummary, type SessionStoryView } from "@soulstream/mcp-contract";
import { searchSessionEvents } from "@soulstream/search-contract";
import { DEFAULT_EXCLUDED_USER_MESSAGE_SOURCES } from "../control_plane/repositories/event_read_repository.js";
import { applyToolContentPolicy } from "./session_content_policy.js";
import { SessionConsumptionBoundary } from "./session_consumption_boundary.js";
import { readSessionFolders, sessionReadAdapter, type McpSessionReadAdapter, type McpSessionRow } from "./session_read_adapter.js";
import type { McpCallContext, McpToolHandler } from "./types.js";
type SessionArgs<N extends keyof typeof sessionTools> = z.infer<z.ZodObject<typeof sessionTools[N]["config"]["inputSchema"]>>;
const TOOL_TRUNCATE_DEFAULT = 500;

export const sessionQueryHandlers = {
  list_sessions: async (options, args, context) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const repositories = await options.sessions.repositoryProvider();
      const runtime = { db: { ...sessionReadAdapter(repositories), getAllFolders: () => readSessionFolders(options.folders) } };
      const consumptionBoundary = new SessionConsumptionBoundary(repositories.deliveries, context);
      const handler = async ({ cursor, limit, search, folder_id, folder_name, node_id, node_name }: SessionArgs<"list_sessions">) => {
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
    };
      return await handler(args as SessionArgs<"list_sessions">);
    } catch (error) {
      // Uncaught legacy callbacks are converted by the SDK without structuredContent.
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
  list_session_events: async (options, args, context) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const repositories = await options.sessions.repositoryProvider();
      const runtime = { db: { ...sessionReadAdapter(repositories) } };
      const consumptionBoundary = new SessionConsumptionBoundary(repositories.deliveries, context);
      const handler = async ({ session_id, cursor, limit, tool_truncate_chars, event_types, tool_content }: SessionArgs<"list_session_events">) => {
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
    };
      return await handler(args as SessionArgs<"list_session_events">);
    } catch (error) {
      // Uncaught legacy callbacks are converted by the SDK without structuredContent.
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
  get_session_event: async (options, args, context) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const repositories = await options.sessions.repositoryProvider();
      const runtime = { db: { ...sessionReadAdapter(repositories) } };
      const consumptionBoundary = new SessionConsumptionBoundary(repositories.deliveries, context);
      const handler = async ({ session_id, event_id }: SessionArgs<"get_session_event">) => {
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
    };
      return await handler(args as SessionArgs<"get_session_event">);
    } catch (error) {
      // Uncaught legacy callbacks are converted by the SDK without structuredContent.
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
  list_user_messages: async (options, args) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const repositories = await options.sessions.repositoryProvider();
      const runtime = { db: { ...sessionReadAdapter(repositories) } };
      const handler = async ({ since, until, sources, cursor, limit, max_text_chars }: SessionArgs<"list_user_messages">) => {
      const sinceDate = parseOffsetTimestamp(since);
      const untilDate = until === undefined ? new Date() : parseOffsetTimestamp(until);
      if (!sinceDate) return errorResult(`since는 오프셋이 명시된 ISO 8601 시각이어야 합니다: ${since}`);
      if (!untilDate) return errorResult(`until은 오프셋이 명시된 ISO 8601 시각이어야 합니다: ${until}`);
      if (sinceDate.getTime() >= untilDate.getTime()) {
        return errorResult("since는 until보다 앞서야 합니다.");
      }
      const c = cursor ?? 0;
      const l = limit ?? 100;
      const maxChars = max_text_chars ?? 2000;
      const { rows, total } = await runtime.db.listUserMessages({
        since: sinceDate,
        until: untilDate,
        sources: sources ?? null,
        excludedSources: sources ? [] : DEFAULT_EXCLUDED_USER_MESSAGE_SOURCES,
        offset: c,
        limit: l,
        maxTextChars: maxChars,
      });
      return jsonResult({
        since: sinceDate.toISOString(),
        until: untilDate.toISOString(),
        total,
        cursor: c,
        limit: l,
        excluded_sources: sources ? null : [...DEFAULT_EXCLUDED_USER_MESSAGE_SOURCES],
        messages: rows.map((r) => ({
          session_id: r.session_id,
          event_id: r.event_id,
          created_at: serializeDate(r.created_at),
          source: r.source,
          email: r.email,
          user_id: r.user_id,
          display_name: r.display_name,
          session_title: r.session_title,
          node_id: r.node_id,
          agent_id: r.agent_id,
          text: r.text,
          text_chars: r.text_chars,
          truncated: r.text_chars > maxChars,
        })),
        next_cursor: c + l < total ? c + l : null,
      });
    };
      return await handler(args as SessionArgs<"list_user_messages">);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
  get_session_story: async (options, args, context) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const repositories = await options.sessions.repositoryProvider();
      const runtime = { db: { ...sessionReadAdapter(repositories) } };
      const consumptionBoundary = new SessionConsumptionBoundary(repositories.deliveries, context);
      const handler = async ({ session_id, include_highlight }: SessionArgs<"get_session_story">) => {
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
    };
      return await handler(args as SessionArgs<"get_session_story">);
    } catch (error) {
      // Uncaught legacy callbacks are converted by the SDK without structuredContent.
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
  get_session_highlight: async (options, args, context) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const repositories = await options.sessions.repositoryProvider();
      const runtime = { db: { ...sessionReadAdapter(repositories) } };
      const consumptionBoundary = new SessionConsumptionBoundary(repositories.deliveries, context);
      const handler = async ({ session_id }: SessionArgs<"get_session_highlight">) => {
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
    };
      return await handler(args as SessionArgs<"get_session_highlight">);
    } catch (error) {
      // Uncaught legacy callbacks are converted by the SDK without structuredContent.
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
  search_session_history: async (options, args, context) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const repositories = await options.sessions.repositoryProvider();
      const runtime = { db: { ...sessionReadAdapter(repositories) } };
      const consumptionBoundary = new SessionConsumptionBoundary(repositories.deliveries, context);
      const handler = async ({
      query,
      session_ids,
      event_types,
      search_session_id,
      include_turn_summaries,
      include_highlight,
      include_story,
      top_k,
    }: SessionArgs<"search_session_history">, extra: { signal: AbortSignal }) => {
      try {
        const requestSignal = AbortSignal.any([
          extra.signal,
          AbortSignal.timeout(4_800),
        ]);
        const callerSessionId = (context.principal === "external" ? undefined : context.callerSessionId ?? undefined);
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
    };
      return await handler(args as SessionArgs<"search_session_history">, { signal: context.signal ?? new AbortController().signal });
    } catch (error) {
      // Uncaught legacy callbacks are converted by the SDK without structuredContent.
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
  get_session_summary: async (options, args, context) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const repositories = await options.sessions.repositoryProvider();
      const runtime = { db: { ...sessionReadAdapter(repositories) } };
      const consumptionBoundary = new SessionConsumptionBoundary(repositories.deliveries, context);
      const handler = async ({ session_id, max_response_chars }: SessionArgs<"get_session_summary">) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      const { totalEvents, turns } = await runtime.db.getTurnExcerpt(
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
    };
      return await handler(args as SessionArgs<"get_session_summary">);
    } catch (error) {
      // Uncaught legacy callbacks are converted by the SDK without structuredContent.
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
    }: SessionArgs<"get_session_turn_summaries">) => {
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
    };
      return await handler(args as SessionArgs<"get_session_turn_summaries">);
    } catch (error) {
      // Uncaught legacy callbacks are converted by the SDK without structuredContent.
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
  expand_session_turn: async (options, args, context) => {
    try {
      if (!options.sessions) throw new Error("session MCP dependencies are required");
      const repositories = await options.sessions.repositoryProvider();
      const runtime = { db: { ...sessionReadAdapter(repositories) } };
      const consumptionBoundary = new SessionConsumptionBoundary(repositories.deliveries, context);
      const handler = async ({
        session_id,
        turn,
        to_turn,
        include_tools,
        max_chars,
      }: SessionArgs<"expand_session_turn">) => {
        const sessionId = session_id ?? context.callerSessionId;
        if (!sessionId) {
          return errorResult("session_id가 필요합니다. 부른 세션을 알 수 없습니다.");
        }
        const fromTurnNumber = parseTurnReference(turn);
        const toTurnNumber = to_turn === undefined
          ? fromTurnNumber
          : parseTurnReference(to_turn);
        if (toTurnNumber < fromTurnNumber) {
          return errorResult("to_turn은 turn보다 작을 수 없습니다.");
        }
        const turnCount = toTurnNumber - fromTurnNumber + 1;
        if (turnCount > 5) {
          return errorResult("한 번에 최대 5턴까지 조회할 수 있습니다.");
        }
        const session = await runtime.db.getSession(sessionId);
        if (!session) {
          return errorResult(`세션을 찾을 수 없습니다: ${sessionId}`);
        }
        const summaries = await runtime.db.loadTurnSummaryRange(
          sessionId,
          fromTurnNumber,
          toTurnNumber,
          turnCount,
        );
        if (summaries.length === 0) {
          return errorResult(`턴 요약을 찾을 수 없습니다: T${fromTurnNumber}`);
        }
        const transcripts = await runtime.db.loadTurnTranscript(
          sessionId,
          summaries,
          include_tools ?? false,
        );
        const transcriptByTurn = new Map(
          transcripts.map((transcript) => [transcript.turnNumber, transcript.events]),
        );
        const responseMaxChars = max_chars ?? 20000;
        let remainingChars = responseMaxChars;
        let truncated = false;
        let nextEventId: number | null = null;
        const turns: Array<{
          turn_number: number;
          summary: string;
          turn_start_event_id: number | null;
          final_response_event_id: number | null;
          events: Array<{
            event_id: number;
            event_type: string;
            text: string;
            created_at: string | null;
            truncated: boolean;
          }>;
        }> = [];
        let stopAtTruncatedEvent = false;
        for (const summary of summaries) {
          const events = [];
          for (const event of transcriptByTurn.get(summary.turnNumber) ?? []) {
            const eventMaxChars = Math.min(8000, remainingChars);
            if (event.text.length > eventMaxChars) {
              if (eventMaxChars === 0) {
                truncated = true;
                nextEventId = event.eventId;
                stopAtTruncatedEvent = true;
                break;
              }
              events.push({
                event_id: event.eventId,
                event_type: event.eventType,
                text: event.text.slice(0, eventMaxChars),
                created_at: serializeDate(event.createdAt),
                truncated: true,
              });
              truncated = true;
              nextEventId = event.eventId;
              remainingChars -= eventMaxChars;
              stopAtTruncatedEvent = true;
              break;
            }
            events.push({
              event_id: event.eventId,
              event_type: event.eventType,
              text: event.text,
              created_at: serializeDate(event.createdAt),
              truncated: false,
            });
            remainingChars -= event.text.length;
          }
          turns.push({
            turn_number: summary.turnNumber,
            summary: summary.content,
            turn_start_event_id: summary.turnStartEventId,
            final_response_event_id: summary.finalResponseEventId,
            events,
          });
          if (stopAtTruncatedEvent) break;
        }
        const result = jsonResult({
          session_id: sessionId,
          turns,
          truncated,
          next_event_id: nextEventId,
        });
        return consumptionBoundary.commit(
          "expand_session_turn",
          result,
          [{
            session,
            reflectedRevision: summaries[summaries.length - 1]?.eventId ?? null,
          }],
        );
      };
      return await handler(args as SessionArgs<"expand_session_turn">);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
} satisfies Record<string, McpToolHandler>;

function parseTurnReference(value: number | string): number {
  return typeof value === "number" ? value : Number(value.slice(1));
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
  runtime: { db: McpSessionReadAdapter },
  results: Array<{ session_id: string; event_id: number }>,
): Promise<Array<{
  session: McpSessionRow;
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

const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** 오프셋이 명시된 ISO 8601만 받는다. 형식이 맞지 않거나 존재하지 않는 시각이면 null. */
function parseOffsetTimestamp(value: string): Date | null {
  if (!OFFSET_TIMESTAMP.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
