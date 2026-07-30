import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import {
  TurnSummaryQueue,
  resolveTurnSummaryEligibility,
} from "../../src/turn-summary/turn_summary_queue.js";
import type { TurnSummaryConfigService } from "../../src/turn-summary/turn_summary_config.js";
import type { TurnSummarizer } from "../../src/turn-summary/turn_summarizer.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { TurnSummaryProviderUnavailableError } from
  "../../src/turn-summary/turn_summary_provider_router.js";

const silentLogger = pino({ level: "silent" });
const config = {
  provider: "codex" as const,
  model: "gpt-5.6-terra",
  reasoningEffort: "high" as const,
  timeoutMs: 30_000,
  maxAttempts: 2,
  codepointLimit: 6_000,
  historyLimit: 5,
  excludedFolderIds: [
    "055be5a6-1285-48aa-a8a1-59e40fbe59af",
    "9e7baafe-387f-4404-8349-ec994597f4cf",
  ],
};

describe("resolveTurnSummaryEligibility", () => {
  it("applies internal marker, first agent caller, folder blacklist, then include", () => {
    expect(resolveTurnSummaryEligibility({
      metadata: [{ type: "turn_summary_internal", value: true }],
      folderId: null,
      excludedFolderIds: config.excludedFolderIds,
    })).toEqual({ include: false, reason: "internal_summary" });

    expect(resolveTurnSummaryEligibility({
      metadata: [
        { type: "caller_info", value: { source: "agent" } },
        { type: "caller_info", value: { source: "browser" } },
      ],
      folderId: null,
      excludedFolderIds: config.excludedFolderIds,
    })).toEqual({ include: false, reason: "agent_origin" });

    for (const folderId of config.excludedFolderIds) {
      expect(resolveTurnSummaryEligibility({
        metadata: [{ type: "caller_info", value: { source: "browser" } }],
        folderId,
        excludedFolderIds: config.excludedFolderIds,
      })).toEqual({ include: false, reason: "excluded_folder" });
    }

    for (const source of ["api", "channel_observer", "execute-proxy", "llm"]) {
      expect(resolveTurnSummaryEligibility({
        metadata: [{ type: "caller_info", value: { source } }],
        folderId: "music-steam-or-channel-intervention",
        excludedFolderIds: config.excludedFolderIds,
      })).toEqual({ include: true });
    }
  });
});

describe("TurnSummaryQueue", () => {
  it("reads the latest five DB summaries, persists once, and broadcasts the inserted id", async () => {
    const getSession = vi.fn().mockResolvedValue({
      session_id: "sess-1",
      folder_id: "included",
      metadata: [{ type: "caller_info", value: { source: "browser" } }],
    });
    const readLatestEvents = vi.fn().mockResolvedValue([
      { payload: { content: "직전 1" } },
      { payload: { content: "직전 2" } },
    ]);
    const summarize = vi.fn().mockResolvedValue({
      content: "새 요약",
      model: "gpt-5.6-terra",
      latencyMs: 123,
      attempts: 1,
      usage: { input_tokens: 10 },
    });
    let persistedEventSnapshot: Record<string, unknown> | undefined;
    const persistEventWithResult = vi.fn(
      async (_sessionId: string, event: Record<string, unknown>) => {
        persistedEventSnapshot = { ...event };
        return {
          eventId: 77,
          inserted: true,
        };
      },
    );
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const queue = new TurnSummaryQueue({
      db: { getSession, readLatestEvents } as unknown as SessionDB,
      configService: { read: () => config } as unknown as TurnSummaryConfigService,
      summarizer: { summarize } as TurnSummarizer,
      persistence: { persistEventWithResult } as unknown as EventPersistence,
      broadcaster: { emitEventEnvelope } as unknown as SessionBroadcaster,
      logger: silentLogger,
      nowEpochSeconds: () => 1_785_400_000,
    });

    expect(queue.enqueue({
      sessionId: "sess-1",
      userText: "요청",
      assistantText: "결과",
      turnStartEventId: 10,
      finalResponseEventId: 20,
    })).toBeUndefined();
    await queue.drain();

    expect(readLatestEvents).toHaveBeenCalledWith("sess-1", 5, ["turn_summary"]);
    expect(summarize).toHaveBeenCalledWith({
      userText: "요청",
      assistantText: "결과",
      previousSummaries: ["직전 1", "직전 2"],
    }, config);
    expect(persistedEventSnapshot).toMatchObject({
      type: "turn_summary",
      content: "새 요약",
      turn_start_event_id: 10,
      final_response_event_id: 20,
      parent_event_id: 20,
      model: "gpt-5.6-terra",
      latency_ms: 123,
      attempts: 1,
      usage: { input_tokens: 10 },
      timestamp: 1_785_400_000,
      _dedupe_key: "turn_summary:10:20",
    });
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        type: "turn_summary",
        _event_id: 77,
      }),
    );
    expect(emitEventEnvelope.mock.calls[0][1]._dedupe_key).toBeUndefined();
  });

  it("does not broadcast a deduplicated summary", async () => {
    const emitEventEnvelope = vi.fn();
    const queue = new TurnSummaryQueue({
      db: {
        getSession: vi.fn().mockResolvedValue({
          folder_id: "included",
          metadata: [],
        }),
        readLatestEvents: vi.fn().mockResolvedValue([]),
      } as unknown as SessionDB,
      configService: { read: () => config } as unknown as TurnSummaryConfigService,
      summarizer: {
        summarize: vi.fn().mockResolvedValue({
          content: "중복 요약",
          model: "gpt-5.6-terra",
          latencyMs: 1,
          attempts: 1,
        }),
      },
      persistence: {
        persistEventWithResult: vi.fn().mockResolvedValue({
          eventId: 77,
          inserted: false,
        }),
      } as unknown as EventPersistence,
      broadcaster: { emitEventEnvelope } as unknown as SessionBroadcaster,
      logger: silentLogger,
    });

    queue.enqueue({
      sessionId: "sess-1",
      userText: "요청",
      assistantText: "결과",
      turnStartEventId: 10,
      finalResponseEventId: 20,
    });
    await queue.drain();

    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("silently skips the optional API provider when its key is unavailable", async () => {
    const warn = vi.fn();
    const persistEventWithResult = vi.fn();
    const queue = new TurnSummaryQueue({
      db: {
        getSession: vi.fn().mockResolvedValue({
          folder_id: "included",
          metadata: [],
        }),
        readLatestEvents: vi.fn().mockResolvedValue([]),
      } as unknown as SessionDB,
      configService: {
        read: () => ({ ...config, provider: "openai-api" }),
      } as unknown as TurnSummaryConfigService,
      summarizer: {
        summarize: vi.fn().mockRejectedValue(
          new TurnSummaryProviderUnavailableError("openai-api"),
        ),
      },
      persistence: { persistEventWithResult } as unknown as EventPersistence,
      broadcaster: {
        emitEventEnvelope: vi.fn(),
      } as unknown as SessionBroadcaster,
      logger: { warn } as unknown as typeof silentLogger,
    });

    queue.enqueue({
      sessionId: "sess-1",
      userText: "요청",
      assistantText: "결과",
      turnStartEventId: 10,
      finalResponseEventId: 20,
    });
    await queue.drain();

    expect(warn).not.toHaveBeenCalled();
    expect(persistEventWithResult).not.toHaveBeenCalled();
  });

  it("preserves per-session order without blocking another session", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const startedSummaries: string[] = [];
    const persistedSessions: string[] = [];
    const queue = new TurnSummaryQueue({
      db: {
        getSession: vi.fn().mockResolvedValue({
          folder_id: "included",
          metadata: [],
        }),
        readLatestEvents: vi.fn().mockResolvedValue([]),
      } as unknown as SessionDB,
      configService: { read: () => config } as unknown as TurnSummaryConfigService,
      summarizer: {
        summarize: vi.fn(async ({ userText }) => {
          startedSummaries.push(userText);
          if (userText === "first") await firstBlocked;
          return {
            content: `${userText} 요약`,
            model: "gpt-5.6-terra",
            latencyMs: 1,
            attempts: 1,
          };
        }),
      },
      persistence: {
        persistEventWithResult: vi.fn(async (sessionId: string) => {
          persistedSessions.push(sessionId);
          return { eventId: persistedSessions.length, inserted: true };
        }),
      } as unknown as EventPersistence,
      broadcaster: {
        emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
      } as unknown as SessionBroadcaster,
      logger: silentLogger,
    });

    queue.enqueue({
      sessionId: "sess-blocked",
      userText: "first",
      assistantText: "결과",
      turnStartEventId: 1,
      finalResponseEventId: 2,
    });
    queue.enqueue({
      sessionId: "sess-free",
      userText: "second",
      assistantText: "결과",
      turnStartEventId: 3,
      finalResponseEventId: 4,
    });
    queue.enqueue({
      sessionId: "sess-blocked",
      userText: "third",
      assistantText: "결과",
      turnStartEventId: 5,
      finalResponseEventId: 6,
    });

    await vi.waitFor(() => {
      expect(persistedSessions).toEqual(["sess-free"]);
    });
    expect(startedSummaries).toEqual(["first", "second"]);
    releaseFirst();
    await queue.drain();
    expect(startedSummaries).toEqual(["first", "second", "third"]);
    expect(persistedSessions).toEqual([
      "sess-free",
      "sess-blocked",
      "sess-blocked",
    ]);
  });
});
