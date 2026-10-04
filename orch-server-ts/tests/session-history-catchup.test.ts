import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerSessionHistoryRoutes } from "../src/session/session_history_routes.js";
import type {
  SessionHistoryProvider,
  SessionHistoryRawEvent,
  SessionHistoryReplayRange,
} from "../src/session/session_history_service.js";

describe("session snapshot catchup capability", () => {
  it.each([200, 201, 2000])("bounds raw catchup and resets only above 200 rows (%i)", async (count) => {
    const { app, provider } = harness(rawEvents(count));
    try {
      const response = await app.inject({ url: "/api/sessions/s/events?lastEventId=5&snapshotCatchup=1" });
      const frames = parseFrames(response.body);
      expect(response.statusCode).toBe(200);
      expect(provider.streamEventsRaw).toHaveBeenCalledWith("s", 5, { limit: 201, throughId: count + 5 });
      expect(frames.filter((f) => f.id)).toHaveLength(count > 200 ? 0 : count);
      expect(frames.at(-1)?.data).toEqual({
        type: "history_sync", last_event_id: count + 5, is_live: false,
        reset_required: count > 200,
        ...(count > 200 ? { reset_reason: "catchup_overflow" } : {}),
      });
    } finally { await app.close(); }
  });

  it.each([201, 2000])("keeps unbounded legacy replay without capability (%i)", async (count) => {
    const { app, provider } = harness(rawEvents(count));
    try {
      const response = await app.inject({ url: "/api/sessions/s/events?lastEventId=5" });
      expect(parseFrames(response.body).filter((f) => f.id)).toHaveLength(count);
      expect(provider.streamEventsRaw).toHaveBeenCalledWith("s", 5);
      expect(parseFrames(response.body).at(-1)?.data.reset_required).toBe(false);
    } finally { await app.close(); }
  });

  it("counts actual raw rows before semantic filtering rather than event id distance", async () => {
    const rows = rawEvents(200).map((e, i) => ({ ...e, eventId: 6 + i * 10 }));
    const { app } = harness(rows);
    try {
      const response = await app.inject({ url: "/api/sessions/s/events?lastEventId=5&snapshotCatchup=1" });
      expect(parseFrames(response.body).filter((f) => f.id)).toHaveLength(200);
      expect(parseFrames(response.body).at(-1)?.data.reset_required).toBe(false);
    } finally { await app.close(); }

    const rejectedRows = rawEvents(201).map((e) => ({ ...e, eventType: "session_ended", sessionEffectApplied: false }));
    const rejected = harness(rejectedRows);
    try {
      const response = await rejected.app.inject({ url: "/api/sessions/s/events?lastEventId=5&snapshotCatchup=1" });
      expect(parseFrames(response.body).at(-1)?.data.reset_reason).toBe("catchup_overflow");
    } finally { await rejected.app.close(); }
  });

  it("keeps semantic and finalized-text filtering below the threshold", async () => {
    const rows: SessionHistoryRawEvent[] = [
      { eventId: 6, eventType: "text_delta", payloadText: JSON.stringify({ type: "text_delta", _live_only: true, tool_use_id: "t", text: "partial" }) },
      { eventId: 7, eventType: "assistant_message", payloadText: JSON.stringify({ type: "assistant_message", _final_for_live_stream: true, tool_use_id: "t", text: "final" }) },
      { eventId: 8, eventType: "session_ended", payloadText: "{}", sessionEffectApplied: false },
    ];
    const { app } = harness(rows);
    try {
      const response = await app.inject({ url: "/api/sessions/s/events?lastEventId=5&snapshotCatchup=1" });
      expect(parseFrames(response.body).filter((f) => f.id).map((f) => f.id)).toEqual(["7"]);
      expect(parseFrames(response.body).at(-1)?.data.reset_required).toBe(false);
    } finally { await app.close(); }
  });

  it("preserves cursor-ahead and history-gap reset contracts for capability clients", async () => {
    for (const [rows, afterId, reason] of [[[], 10, "cursor_ahead"], [rawEvents(1), 1, "history_gap"]] as const) {
      const { app } = harness([...rows]);
      try {
        const response = await app.inject({ url: `/api/sessions/s/events?lastEventId=${afterId}&snapshotCatchup=1` });
        expect(parseFrames(response.body).at(-1)?.data).toMatchObject({ reset_required: true, reset_reason: reason });
      } finally { await app.close(); }
    }
  });

  it("keeps the captured watermark and post-boundary live tail on overflow", async () => {
    const { app, provider } = harness(rawEvents(2000));
    let listener: (e: Record<string, unknown>) => void = () => {};
    const unsubscribe = vi.fn();
    provider.readLastEventId = vi.fn(async () => {
      listener({ eventId: 205, event: { type: "tool_result", _event_id: 205 } });
      listener({ eventId: 207, event: { type: "assistant_message", _event_id: 207, text: "tail" } });
      listener({ eventId: 207, event: { type: "assistant_message", _event_id: 207, text: "tail" } });
      listener({ event: { type: "text_delta", _live_only: true, liveSeq: 1, text: "covered" } });
      listener({ event: { type: "text_delta", _live_only: true, liveSeq: 2, text: "new text" } });
      return 206;
    });
    // Same production route registration, with the existing subscribe-before-read contract.
    const liveApp = Fastify();
    registerSessionHistoryRoutes(liveApp, {
      provider,
      liveEvents: {
        subscribe: (_sid, cb) => { listener = cb; return unsubscribe; },
        snapshotLiveText: () => ({ throughLiveSeq: 1, streams: [] }),
      },
      closeAfterHistorySync: true,
    });
    try {
      const response = await liveApp.inject({ url: "/api/sessions/s/events?lastEventId=5&snapshotCatchup=1" });
      const frames = parseFrames(response.body);
      expect(frames.map((f) => f.event)).toEqual(["init", "text_snapshot", "history_sync", "assistant_message", "text_delta"]);
      expect(frames[1]?.data).toMatchObject({ basedOnEventId: 206, throughLiveSeq: 1 });
      expect(frames[2]?.data).toMatchObject({ reset_required: true, reset_reason: "catchup_overflow", last_event_id: 206 });
      expect(frames[3]?.id).toBe("207");
      expect(frames[4]?.data.text).toBe("new text");
      expect(provider.streamEventsRaw).toHaveBeenCalledWith("s", 5, { limit: 201, throughId: 206 });
      expect(unsubscribe).toHaveBeenCalledOnce();
    } finally { await app.close(); await liveApp.close(); }
  });
});

function rawEvents(count: number): SessionHistoryRawEvent[] {
  return Array.from({ length: count }, (_, i) => ({ eventId: i + 6, eventType: "tool_result", payloadText: JSON.stringify({ type: "tool_result", tool_use_id: `t-${i}` }) }));
}

function harness(rows: SessionHistoryRawEvent[]) {
  const provider: SessionHistoryProvider = {
    readViewport: vi.fn(async () => []), readMessages: vi.fn(async (): Promise<[unknown[], string | null]> => [[], null]),
    readTimeline: vi.fn(async (): Promise<[unknown[], string | null]> => [[], null]), readTimelineTrace: vi.fn(async () => null),
    readStory: vi.fn(async () => ({ highlight: null, narrative: null, unfolded_turn_summaries: [], narrative_through_event_id: null, fold_count: 0, updated_at: null })),
    readTurnSummaries: vi.fn(async (session_id: string) => ({ session_id, mode: "count" as const, total_count: 0, digested_count: 0, undigested_count: 0 })),
    readConversationContext: vi.fn(async (session_id: string) => ({ session_id, anchor: "latest_conversation" as const, match_event_id: null, match_turn_number: null, turns: [] })),
    readLastEventId: vi.fn(async () => rows.at(-1)?.eventId ?? 0),
    streamEventsRaw: vi.fn(async function* (_sid: string, afterId: number, range?: SessionHistoryReplayRange) {
      const selected = rows.filter((e) => e.eventId > afterId && (range?.throughId === undefined || e.eventId <= range.throughId));
      yield* range?.limit === undefined ? selected : selected.slice(0, range.limit);
    }),
  };
  const app = Fastify();
  registerSessionHistoryRoutes(app, { provider, closeAfterHistorySync: true });
  return { app, provider };
}

function parseFrames(body: string) {
  return body.trim().split("\n\n").map((chunk) => {
    const lines = chunk.split("\n");
    return { event: lines.find((l) => l.startsWith("event: "))?.slice(7), id: lines.find((l) => l.startsWith("id: "))?.slice(4), data: JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6)) };
  });
}
