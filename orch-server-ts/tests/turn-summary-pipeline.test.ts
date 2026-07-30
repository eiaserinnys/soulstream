import { describe, expect, it, vi } from "vitest";

import type { NodeRegistryEvent } from "../src/node/registry.js";
import { RuntimeSessionEventHub } from "../src/runtime/session_event_hub.js";
import {
  reconstructTurnFromEvents,
  type TurnSummaryEventRow,
  type TurnSummaryRepositoryPort,
} from "../src/turn-summary/turn_summary_repository.js";
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
  provider: "codex",
  model: "gpt-5.6-terra",
  reasoningEffort: "high",
  timeoutMs: 30_000,
  maxAttempts: 2,
  codepointLimit: 6_000,
  historyLimit: 5,
  excludedFolderIds: [
    "055be5a6-1285-48aa-a8a1-59e40fbe59af",
    "9e7baafe-387f-4404-8349-ec994597f4cf",
  ],
};

describe("turn reconstruction", () => {
  it("pairs starts and completes by ordinal across an interleaved intervention", () => {
    const rows: TurnSummaryEventRow[] = [
      event(1, "user_message", { text: "첫 요청" }),
      event(2, "assistant_message", { content: "첫 응답" }),
      event(3, "intervention_sent", { text: "두 번째 요청" }),
      event(4, "complete", {}),
      event(5, "assistant_message", { content: "두 번째 응답 초안" }),
      event(6, "assistant_message", { content: "두 번째 최종 응답" }),
      event(7, "complete", {}),
    ];

    expect(reconstructTurnFromEvents(rows, 4)).toEqual({
      turnStartEventId: 1,
      finalResponseEventId: 2,
      userText: "첫 요청",
      assistantText: "첫 응답",
    });
    expect(reconstructTurnFromEvents(rows, 7)).toEqual({
      turnStartEventId: 3,
      finalResponseEventId: 6,
      userText: "두 번째 요청",
      assistantText: "두 번째 최종 응답",
    });
  });

  it.each([
    ["user_message", "사용자 요청"],
    ["intervention_sent", "개입 요청"],
    ["session_notification", "자동 전달"],
  ])("accepts %s as a turn start", (eventType, text) => {
    expect(reconstructTurnFromEvents([
      event(10, eventType, { text }),
      event(11, "assistant_message", { content: "응답" }),
      event(12, "complete", {}),
    ], 12)?.userText).toBe(text);
  });

  it("skips a turn with a fatal error or missing anchors", () => {
    expect(reconstructTurnFromEvents([
      event(1, "user_message", { text: "요청" }),
      event(2, "error", { fatal: true }),
      event(3, "assistant_message", { content: "부분 응답" }),
      event(4, "complete", {}),
    ], 4)).toBeNull();
    expect(reconstructTurnFromEvents([
      event(1, "user_message", { text: "요청" }),
      event(2, "complete", {}),
    ], 2)).toBeNull();
  });
});

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
        model: "gpt-5.6-terra",
        latencyMs: 70,
        attempts: 1,
        usage: { input_tokens: 10 },
      }),
    };
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer,
      eventHub: hub,
      logger: { info: vi.fn(), warn: vi.fn() },
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
        turn_start_event_id: 10,
        final_response_event_id: 19,
        parent_event_id: 19,
        timestamp: 123,
      }),
      "turn_summary:10:19",
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
  });

  it("prechecks dedupe before invoking the provider", async () => {
    const repository = fakeRepository();
    repository.hasSummary.mockResolvedValue(true);
    const summarizer = {
      summarize: vi.fn(),
    } satisfies TurnSummarizer;
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer,
      eventHub: new RuntimeSessionEventHub(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([nodeEvent("node-a", "session-a", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(summarizer.summarize).not.toHaveBeenCalled();
    expect(repository.appendSummary).not.toHaveBeenCalled();
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
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([nodeEvent("node-a", "session-a", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
    expect(repository.appendSummary).not.toHaveBeenCalled();
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

function event(
  id: number,
  eventType: string,
  payload: Record<string, unknown>,
): TurnSummaryEventRow {
  return { id, eventType, payload, createdAt: new Date(id * 1_000) };
}

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
