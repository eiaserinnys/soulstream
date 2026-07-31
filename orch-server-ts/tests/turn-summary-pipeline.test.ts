import { describe, expect, it, vi } from "vitest";

import type { NodeRegistryEvent } from "../src/node/registry.js";
import { RuntimeSessionEventHub } from "../src/runtime/session_event_hub.js";
import type { TurnSummaryRepositoryPort } from
  "../src/turn-summary/turn_summary_repository.js";
import {
  collectTurnSummaryCompleteJobs,
  resolveTurnSummaryEligibility,
  TurnSummaryPipeline,
} from "../src/turn-summary/turn_summary_pipeline.js";
import type { TurnSummaryConfig } from "../src/turn-summary/turn_summary_config.js";
import type { TurnSummarizer } from "../src/turn-summary/turn_summarizer.js";

const CONFIG: TurnSummaryConfig = {
  enabled: true,
  instruction: "한국어 1~3줄로 요약하라.",
  storyInstruction: "마커를 붙인 narrative와 highlight를 JSON으로 반환하라.",
  storyFoldThreshold: 10,
  storyFoldBatchSize: 5,
  storyCompletionGraceMs: 1_800_000,
  storyCompletionMinSummaries: 5,
  storyCompletionSweepIntervalMs: 60_000,
  storyNarrativeMaxChars: 1_500,
  provider: "codex",
  model: "gpt-5.6-terra",
  storyModel: "gpt-5.6-terra",
  reasoningEffort: "high",
  timeoutMs: 30_000,
  maxAttempts: 2,
  codexConcurrencyLimit: 2,
  codepointLimit: 6_000,
  historyLimit: 5,
  excludedFolderIds: [
    "055be5a6-1285-48aa-a8a1-59e40fbe59af",
    "9e7baafe-387f-4404-8349-ec994597f4cf",
  ],
};

describe("complete observation", () => {
  it("accepts only durable complete events from the node relay", () => {
    expect(collectTurnSummaryCompleteJobs([
      nodeEvent("node-a", "session-a", {
        type: "complete",
        _event_id: 42,
      }),
      nodeEvent("node-a", "session-a", {
        type: "complete",
      }),
      nodeEvent("node-a", "session-a", {
        type: "assistant_message",
        _event_id: 41,
      }),
    ])).toEqual([{
      nodeId: "node-a",
      sessionId: "session-a",
      completeEventId: 42,
    }]);
  });
});

describe("turn summary policy", () => {
  it("applies internal, first caller, and folder filters in that order", () => {
    expect(resolveTurnSummaryEligibility({
      metadata: [
        { type: "turn_summary_internal" },
        { type: "caller_info", value: { source: "agent" } },
      ],
      folderId: CONFIG.excludedFolderIds[0] ?? null,
      excludedFolderIds: CONFIG.excludedFolderIds,
    })).toEqual({ include: false, reason: "internal_summary" });
    expect(resolveTurnSummaryEligibility({
      metadata: [
        { type: "caller_info", value: { source: "agent" } },
        { type: "caller_info", value: { source: "browser" } },
      ],
      folderId: CONFIG.excludedFolderIds[0] ?? null,
      excludedFolderIds: CONFIG.excludedFolderIds,
    })).toEqual({ include: false, reason: "agent_origin" });
  });

  it.each([
    [
      [{ type: "turn_summary_internal" }],
      null,
      "internal_summary",
    ],
    [
      [{ type: "caller_info", value: { source: "agent" } }],
      null,
      "agent_origin",
    ],
    [
      [{ type: "caller_info", value: { source: "browser" } }],
      "055be5a6-1285-48aa-a8a1-59e40fbe59af",
      "excluded_folder",
    ],
  ])("excludes policies in priority order", (metadata, folderId, reason) => {
    expect(resolveTurnSummaryEligibility({
      metadata,
      folderId,
      excludedFolderIds: CONFIG.excludedFolderIds,
    })).toEqual({ include: false, reason });
  });

  it.each(["browser", "slack", "api", "channel_observer", "llm"])(
    "includes non-agent automatic source %s outside excluded folders",
    (source) => {
      expect(resolveTurnSummaryEligibility({
        metadata: [{ type: "caller_info", value: { source } }],
        folderId: "allowed-folder",
        excludedFolderIds: CONFIG.excludedFolderIds,
      })).toEqual({ include: true });
    },
  );
});

describe("TurnSummaryPipeline", () => {
  it("does no DB or provider work while the hot-reloaded feature flag is off", async () => {
    const repository = fakeRepository();
    const summarizer = {
      summarize: vi.fn(),
    } satisfies TurnSummarizer;
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => ({ ...CONFIG, enabled: false }) },
      summarizer,
      eventHub: new RuntimeSessionEventHub(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([nodeEvent("node-a", "session-a", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(repository.loadTurn).not.toHaveBeenCalled();
    expect(summarizer.summarize).not.toHaveBeenCalled();
    expect(repository.appendSummary).not.toHaveBeenCalled();
  });

  it("publishes DB gap events before the newly appended summary", async () => {
    const repository = fakeRepository();
    const hub = new RuntimeSessionEventHub();
    const seen: Record<string, unknown>[] = [];
    hub.subscribe("session-a", (event) => seen.push(event.data));
    const summarizer: TurnSummarizer = {
      summarize: vi.fn().mockResolvedValue({
        content: "요약",
        model: "gpt-5.6-luna",
        latencyMs: 70,
        attempts: 1,
        spawnDurationMs: 60,
        peakConcurrentSpawns: 2,
        usage: { input_tokens: 10 },
      }),
    };
    const info = vi.fn();
    const appendSessionUpdate = vi.fn();
    const foldIfNeeded = vi.fn().mockResolvedValue(undefined);
    repository.appendSummary.mockResolvedValue({
      inserted: true,
      eventId: 22,
      previewUpdate: {
        status: "running",
        updatedAt: "2026-07-31T00:00:00.000Z",
        lastMessage: {
          type: "turn_summary",
          preview: "요약",
          timestamp: "2026-07-31T00:00:00.000Z",
        },
        lastEventId: 22,
        lastReadEventId: 20,
      },
    });
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: {
        read: () => ({
          ...CONFIG,
          model: "gpt-5.6-luna",
          storyModel: "gpt-5.6-terra",
        }),
      },
      summarizer,
      eventHub: hub,
      sessionBroadcaster: { append: appendSessionUpdate },
      storyFolder: { foldIfNeeded },
      logger: { info, warn: vi.fn() },
      nowEpochSeconds: () => 123,
    });

    pipeline.accept([nodeEvent("node-a", "session-a", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(repository.appendSummary).toHaveBeenCalledWith(
      "session-a",
      expect.objectContaining({
        type: "turn_summary",
        model: "gpt-5.6-luna",
        turn_start_event_id: 10,
        final_response_event_id: 19,
        parent_event_id: 19,
        timestamp: 123,
      }),
      "turn_summary:10:19",
    );
    expect(summarizer.summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        speaker: {
          kind: "user",
          displayName: "Jubok Kim",
          source: "browser",
          userId: "eiaserinnys@gmail.com",
        },
      }),
      expect.objectContaining({
        model: "gpt-5.6-luna",
        storyModel: "gpt-5.6-terra",
      }),
    );
    expect(seen).toEqual([
      {
        type: "event",
        agentSessionId: "session-a",
        event: { type: "progress", _event_id: 21, text: "late" },
      },
      {
        type: "event",
        agentSessionId: "session-a",
        event: expect.objectContaining({
          type: "turn_summary",
          _event_id: 22,
          content: "요약",
        }),
      },
    ]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        latencyMs: 70,
        spawnDurationMs: 60,
        peakConcurrentSpawns: 2,
      }),
      "Turn summary stored",
    );
    expect(appendSessionUpdate).toHaveBeenCalledTimes(1);
    const update = appendSessionUpdate.mock.calls[0]?.[0];
    expect(Object.keys(update ?? {}).sort()).toEqual([
      "agent_session_id",
      "last_event_id",
      "last_message",
      "last_read_event_id",
      "status",
      "type",
      "updated_at",
    ]);
    expect(update).toEqual({
      type: "session_updated",
      agent_session_id: "session-a",
      status: "running",
      updated_at: "2026-07-31T00:00:00.000Z",
      last_message: {
        type: "turn_summary",
        preview: "요약",
        timestamp: "2026-07-31T00:00:00.000Z",
      },
      last_event_id: 22,
      last_read_event_id: 20,
    });
    expect(foldIfNeeded).toHaveBeenCalledWith("session-a");
  });

  it("prechecks dedupe before invoking the provider", async () => {
    const repository = fakeRepository();
    repository.hasSummary.mockResolvedValue(true);
    const debug = vi.fn();
    const summarizer = {
      summarize: vi.fn(),
    } satisfies TurnSummarizer;
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer,
      eventHub: new RuntimeSessionEventHub(),
      logger: { debug, info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([nodeEvent("node-a", "session-a", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(summarizer.summarize).not.toHaveBeenCalled();
    expect(repository.appendSummary).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "already_summarized",
        sessionId: "session-a",
        completeEventId: 20,
      }),
      "Turn summary skipped",
    );
  });

  it.each([
    ["turn_not_reconstructable", (repository: ReturnType<typeof fakeRepository>) => {
      repository.loadTurn.mockResolvedValue(null);
    }],
    ["excluded_folder", (repository: ReturnType<typeof fakeRepository>) => {
      repository.loadTurn.mockResolvedValue({
        sessionId: "session-a",
        folderId: CONFIG.excludedFolderIds[0] ?? null,
        metadata: [{ type: "caller_info", value: { source: "browser" } }],
        turnStartEventId: 10,
        finalResponseEventId: 19,
        userText: "요청",
        assistantText: "응답",
      });
    }],
    ["session_not_summarizable", (repository: ReturnType<typeof fakeRepository>) => {
      repository.isSessionSummarizable.mockResolvedValue(false);
    }],
  ])("debug-logs the %s skip reason", async (reason, arrange) => {
    const repository = fakeRepository();
    arrange(repository);
    const debug = vi.fn();
    const summarizer = {
      summarize: vi.fn(),
    } satisfies TurnSummarizer;
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer,
      eventHub: new RuntimeSessionEventHub(),
      logger: { debug, info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([nodeEvent("node-a", "session-a", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        reason,
        sessionId: "session-a",
        completeEventId: 20,
      }),
      "Turn summary skipped",
    );
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it("logs one skip and leaves persistence untouched when the provider fails", async () => {
    const repository = fakeRepository();
    const warn = vi.fn();
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer: {
        summarize: vi.fn().mockRejectedValue(
          new Error("provider timeout"),
        ),
      },
      eventHub: new RuntimeSessionEventHub(),
      logger: { info: vi.fn(), warn },
    });

    pipeline.accept([nodeEvent("node-a", "session-a", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        completeEventId: 20,
      }),
      "Turn summary skipped",
    );
    expect(repository.appendSummary).not.toHaveBeenCalled();
  });

  it("skips an interrupted session even if interruption settles during the model call", async () => {
    const repository = fakeRepository();
    repository.isSessionSummarizable
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const debug = vi.fn();
    const summarizer = {
      summarize: vi.fn().mockResolvedValue({
        content: "폐기할 요약",
        model: "gpt-5.6-terra",
        latencyMs: 10,
        attempts: 1,
      }),
    } satisfies TurnSummarizer;
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer,
      eventHub: new RuntimeSessionEventHub(),
      logger: { debug, info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([nodeEvent("node-a", "session-a", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
    expect(repository.appendSummary).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "session_not_summarizable",
        phase: "after_summarization",
      }),
      "Turn summary skipped",
    );
  });

  it("serializes one session while allowing different sessions to overlap", async () => {
    const repository = fakeRepository();
    const blockers: Array<() => void> = [];
    const summarize = vi.fn().mockImplementation(() =>
      new Promise((resolve) => blockers.push(() => resolve({
        content: "요약",
        model: "gpt-5.6-terra",
        latencyMs: 1,
        attempts: 1,
      })))
    );
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer: { summarize },
      eventHub: new RuntimeSessionEventHub(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([
      nodeEvent("node-a", "session-a", { type: "complete", _event_id: 20 }),
      nodeEvent("node-a", "session-a", { type: "complete", _event_id: 30 }),
      nodeEvent("node-b", "session-b", { type: "complete", _event_id: 20 }),
    ]);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(2));
    blockers.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(3));
    blockers.splice(0).forEach((release) => release());
    await pipeline.drain();
  });
});

function nodeEvent(
  nodeId: string,
  sessionId: string,
  eventPayload: Record<string, unknown>,
): NodeRegistryEvent {
  return {
    type: "node_session_event",
    nodeId,
    data: {
      type: "event",
      agentSessionId: sessionId,
      event: eventPayload,
    },
  };
}

function fakeRepository() {
  return {
    loadTurn: vi.fn().mockImplementation(
      async (sessionId: string, completeEventId: number) => ({
        sessionId,
        folderId: "allowed-folder",
        metadata: [{ type: "caller_info", value: { source: "browser" } }],
        turnStartEventId: completeEventId - 10,
        finalResponseEventId: completeEventId - 1,
        userText: "요청",
        assistantText: "응답",
        speaker: {
          kind: "user",
          displayName: "Jubok Kim",
          source: "browser",
          userId: "eiaserinnys@gmail.com",
        },
      }),
    ),
    hasSummary: vi.fn().mockResolvedValue(false),
    loadPreviousSummaries: vi.fn().mockResolvedValue(["직전 요약"]),
    isSessionSummarizable: vi.fn().mockResolvedValue(true),
    appendSummary: vi.fn().mockResolvedValue({ inserted: true, eventId: 22 }),
    loadGapEvents: vi.fn().mockResolvedValue([{
      type: "event",
      agentSessionId: "session-a",
      event: { type: "progress", _event_id: 21, text: "late" },
    }]),
  } satisfies Record<keyof TurnSummaryRepositoryPort, ReturnType<typeof vi.fn>>;
}
