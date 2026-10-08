import { describe, expect, it, vi } from "vitest";
import { parsePersistentInstructionsApplyPayload } from
  "@soulstream/wire-schema/persistent-session-instructions";

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
import type { TurnSummaryStartEvidence } from
  "../src/turn-summary/turn_summary_completion_evidence.js";

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
      startEvidence: { kind: "user_message", evidenceState: "complete" },
    })).toEqual({ include: false, reason: "internal_summary" });
    expect(resolveTurnSummaryEligibility({
      metadata: [
        { type: "caller_info", value: { source: "agent" } },
        { type: "caller_info", value: { source: "browser" } },
      ],
      folderId: CONFIG.excludedFolderIds[0] ?? null,
      excludedFolderIds: CONFIG.excludedFolderIds,
      startEvidence: { kind: "user_message", evidenceState: "complete" },
    })).toEqual({ include: false, reason: "agent_origin" });
  });

  it("allows agent-origin persistent sessions while keeping ordinary sessions excluded", () => {
    const common = {
      folderId: "allowed-folder",
      excludedFolderIds: CONFIG.excludedFolderIds,
      startEvidence: { kind: "user_message" as const, evidenceState: "complete" as const },
    };
    const agentMetadata = [
      { type: "caller_info", value: { source: "agent" } },
      { type: "persistent_session", value: { enabled: true } },
    ];

    expect(resolveTurnSummaryEligibility({
      ...common,
      metadata: agentMetadata,
    })).toEqual({ include: true, reason: "user_input" });
    expect(resolveTurnSummaryEligibility({
      ...common,
      metadata: [{ type: "caller_info", value: { source: "agent" } }],
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
      startEvidence: { kind: "user_message", evidenceState: "complete" },
    })).toEqual({ include: false, reason });
  });

  it.each(["browser", "slack", "api", "channel_observer", "llm"])(
    "includes non-agent automatic source %s outside excluded folders",
    (source) => {
      expect(resolveTurnSummaryEligibility({
        metadata: [{ type: "caller_info", value: { source } }],
        folderId: "allowed-folder",
        excludedFolderIds: CONFIG.excludedFolderIds,
        startEvidence: { kind: "user_message", evidenceState: "complete" },
      })).toEqual({ include: true, reason: "user_input" });
    },
  );

  it.each([
    [
      { kind: "user_message", evidenceState: "complete" },
      { include: true, reason: "user_input" },
    ],
    [
      { kind: "intervention_sent", evidenceState: "complete" },
      { include: true, reason: "intervention" },
    ],
    [
      { kind: "system_notification", evidenceState: "complete" },
      { include: false, reason: "system_notification" },
    ],
    [
      {
        kind: "completion_notification",
        evidenceState: "legacy_missing_relation",
        childSessionId: null,
        currentRevision: null,
        previousCompletedRevision: null,
        currentTerminalStatus: null,
        hasNewExternalInput: null,
      },
      { include: true, reason: "legacy_evidence_missing" },
    ],
    [
      completionEvidence({ currentTerminalStatus: "error" }),
      { include: false, reason: "delegated_terminal_failure" },
    ],
    [
      completionEvidence({ previousCompletedRevision: null }),
      { include: true, reason: "first_delegated_completion" },
    ],
    [
      completionEvidence({ hasNewExternalInput: true }),
      { include: true, reason: "delegated_completion_after_new_input" },
    ],
    [
      completionEvidence({ hasNewExternalInput: false }),
      {
        include: false,
        reason: "delegated_completion_without_new_input",
      },
    ],
  ])("applies the structural eligibility decision table %#", (
    startEvidence,
    expected,
  ) => {
    expect(resolveTurnSummaryEligibility({
      metadata: [{ type: "caller_info", value: { source: "browser" } }],
      folderId: "allowed-folder",
      excludedFolderIds: CONFIG.excludedFolderIds,
      startEvidence: startEvidence as TurnSummaryStartEvidence,
    })).toEqual(expected);
  });

  it("fails open when previous completed evidence is missing", () => {
    expect(resolveTurnSummaryEligibility({
      metadata: [{ type: "caller_info", value: { source: "browser" } }],
      folderId: "allowed-folder",
      excludedFolderIds: CONFIG.excludedFolderIds,
      startEvidence: completionEvidence({
        evidenceState: "legacy_missing_previous_terminal",
        hasNewExternalInput: null,
      }),
    })).toEqual({ include: true, reason: "legacy_evidence_missing" });
  });

  it.each(["claude", "codex"])(
    "applies the same delegated completion policy to a %s parent",
    (backend) => {
      expect(resolveTurnSummaryEligibility({
        metadata: {
          backend,
          caller_info: { source: "browser" },
        },
        folderId: "allowed-folder",
        excludedFolderIds: CONFIG.excludedFolderIds,
        startEvidence: completionEvidence({ hasNewExternalInput: false }),
      })).toEqual({
        include: false,
        reason: "delegated_completion_without_new_input",
      });
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
    expect(appendSessionUpdate).not.toHaveBeenCalled();
    expect(foldIfNeeded).toHaveBeenCalledWith("session-a");
  });

  it("skips cache keepalive inputs before summary generation", async () => {
    const repository = fakeRepository();
    repository.loadTurn.mockImplementation(async (sessionId, completeEventId) => ({
      sessionId,
      folderId: "allowed-folder",
      metadata: [{ type: "persistent_session", value: { enabled: true } }],
      turnStartEventId: completeEventId - 10,
      finalResponseEventId: completeEventId - 1,
      userText: "keepalive",
      assistantText: "응답",
      inputPurpose: "cache_keepalive",
      startEvidence: { kind: "user_message", evidenceState: "complete" },
    }));
    const summarizer = { summarize: vi.fn() } satisfies TurnSummarizer;
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

  it("summarizes PAS agent-origin turns but discards their extracted instructions", async () => {
    const repository = fakeRepository();
    repository.loadTurn.mockResolvedValue({
      sessionId: "session-a",
      folderId: "allowed-folder",
      metadata: [
        { type: "caller_info", value: { source: "agent" } },
        { type: "persistent_session", value: { enabled: true } },
      ],
      turnStartEventId: 10,
      finalResponseEventId: 19,
      userText: "위임 보고",
      assistantText: "작업 결과",
      startEvidence: { kind: "user_message", evidenceState: "complete" },
      speaker: { kind: "agent", agentName: "로젤린" },
    });
    const summarize = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: "위임 결과 요약",
        standing_instructions: [{
          text: "항상 짧게 답하라",
          confidence: 0.99,
          existing_id: null,
          source_quote: "위임 보고",
        }],
      }),
      model: "gpt-5.6-luna",
      latencyMs: 1,
      attempts: 1,
    });
    const instructionCommandSender = vi.fn();
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer: { summarize },
      eventHub: new RuntimeSessionEventHub(),
      instructionCommandSender,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([nodeEvent("node-a", "session-a", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({ userText: "위임 보고" }),
      CONFIG,
      expect.objectContaining({
        outputSchema: expect.objectContaining({ type: "object" }),
        extractStandingInstructions: false,
      }),
    );
    expect(repository.appendSummary).toHaveBeenCalledWith(
      "session-a",
      expect.objectContaining({ content: "위임 결과 요약" }),
      "turn_summary:10:19",
    );
    expect(instructionCommandSender).not.toHaveBeenCalled();
  });

  it("extracts human PAS instructions using the persisted turn number and H1 command shape", async () => {
    const repository = fakeRepository();
    repository.loadTurn.mockResolvedValue({
      sessionId: "session-a",
      folderId: "allowed-folder",
      metadata: [
        { type: "caller_info", value: { source: "browser" } },
        { type: "persistent_session", value: { enabled: true } },
        {
          type: "persistent_instructions",
          value: [{
            id: "instruction-existing",
            text: "앞으로 설명은 간결하게 써 줘.",
            source_turns: ["T1"],
            source_event_ids: [3],
            created_at: "2026-10-01T00:00:00.000Z",
            updated_at: "2026-10-01T00:00:00.000Z",
            status: "active",
            origin: "user",
          }],
        },
      ],
      turnStartEventId: 10,
      inputId: "input-10",
      finalResponseEventId: 19,
      userText: "앞으로 설명은 간결하게 써 줘. 앞으로 응답은 한국어로 해 줘.",
      assistantText: "알겠습니다.",
      startEvidence: { kind: "user_message", evidenceState: "complete" },
      speaker: {
        kind: "user",
        displayName: "사용자",
        source: "browser",
      },
    });
    repository.countTurnSummariesThrough.mockResolvedValue(5);
    const summarize = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: "간결한 설명 선호를 확인했다.",
        standing_instructions: [
          {
            text: "앞으로 설명은 간결하게 써 줘.",
            confidence: 0.92,
            existing_id: "instruction-existing",
            source_quote: "앞으로 설명은 간결하게 써 줘.",
          },
          {
            text: "앞으로 응답은 한국어로 해 줘.",
            confidence: 0.7,
            existing_id: null,
            source_quote: "앞으로 응답은 한국어로 해 줘.",
          },
          {
            text: "낮은 신뢰도 항목",
            confidence: 0.69,
            existing_id: null,
            source_quote: "앞으로 응답은 한국어로 해 줘.",
          },
        ],
      }),
      model: "gpt-5.6-luna",
      latencyMs: 1,
      attempts: 1,
    });
    const instructionCommandSender = vi.fn().mockResolvedValue({
      type: "persistent_session_instructions_applied",
    });
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer: { summarize },
      eventHub: new RuntimeSessionEventHub(),
      instructionCommandSender,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([nodeEvent("node-a", "session-a", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(repository.countTurnSummariesThrough).toHaveBeenCalledWith(
      "session-a",
      22,
    );
    expect(repository.appendSummary).toHaveBeenCalledWith(
      "session-a",
      expect.objectContaining({ content: "간결한 설명 선호를 확인했다." }),
      "turn_summary:10:19",
    );
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: "앞으로 설명은 간결하게 써 줘. 앞으로 응답은 한국어로 해 줘.",
      }),
      CONFIG,
      expect.objectContaining({
        persistentInstructions: [{
          id: "instruction-existing",
          text: "앞으로 설명은 간결하게 써 줘.",
        }],
        extractStandingInstructions: true,
        outputSchema: expect.objectContaining({ type: "object" }),
      }),
    );
    const command = instructionCommandSender.mock.calls[0]?.[0];
    expect(parsePersistentInstructionsApplyPayload(command)).toMatchObject({
      ok: true,
      value: {
        session_id: "session-a",
        origin: "extracted",
        anchor: "input-10",
        ops: [
          {
            op: "touch",
            id: "instruction-existing",
            source_turns: ["T5"],
            source_event_ids: [10],
          },
          {
            op: "add",
            text: "앞으로 응답은 한국어로 해 줘.",
            source_turns: ["T5"],
            source_event_ids: [10],
          },
        ],
      },
    });
  });

  it("rejects quotes outside the current human turn and keeps the normal summary path", async () => {
    const repository = fakeRepository();
    const userText = "이 카드도 체크, 큰 문제 없으면 진행.";
    const assistantText = "assistant 발화에서만 온 표현";
    repository.loadPreviousSummaries.mockResolvedValue([
      "이전 요약에서만 온 표현",
    ]);
    repository.loadTurn.mockResolvedValue({
      sessionId: "session-a",
      folderId: "allowed-folder",
      metadata: [
        { type: "caller_info", value: { source: "browser" } },
        { type: "persistent_session", value: { enabled: true } },
        {
          type: "persistent_instructions",
          value: [{
            id: "instruction-active",
            text: "현재 활성 지시에서만 온 표현",
            source_turns: [],
            source_event_ids: [],
            created_at: "2026-10-01T00:00:00.000Z",
            updated_at: "2026-10-01T00:00:00.000Z",
            status: "active",
            origin: "user",
          }],
        },
      ],
      turnStartEventId: 10,
      finalResponseEventId: 19,
      userText,
      assistantText,
      startEvidence: { kind: "user_message", evidenceState: "complete" },
      speaker: { kind: "user", displayName: "사용자", source: "browser" },
    });
    const instructionCommandSender = vi.fn();
    const foldIfNeeded = vi.fn();
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer: {
        summarize: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            summary: "카드 확인을 한 번 요청했다.",
            standing_instructions: [
              {
                text: "내부 프롬프트에서만 온 표현",
                confidence: 0.99,
                existing_id: null,
                source_quote: "현재 사람 발화 자체가 반복 적용할 규칙이나 선호를 표현한 경우만 추출한다.",
              },
              {
                text: "이전 요약 후보",
                confidence: 0.99,
                existing_id: null,
                source_quote: "이전 요약에서만 온 표현",
              },
              {
                text: "assistant 후보",
                confidence: 0.99,
                existing_id: null,
                source_quote: assistantText,
              },
              {
                text: "활성 지시 touch 후보",
                confidence: 0.99,
                existing_id: "instruction-active",
                source_quote: "현재 활성 지시에서만 온 표현",
              },
              {
                text: "인용 누락 후보",
                confidence: 0.99,
                existing_id: null,
              },
              {
                text: "인용 타입 오류 후보",
                confidence: 0.99,
                existing_id: null,
                source_quote: 42,
              },
              {
                text: "빈 인용 후보",
                confidence: 0.99,
                existing_id: null,
                source_quote: "  ",
              },
              {
                text: "불일치 인용 후보",
                confidence: 0.99,
                existing_id: null,
                source_quote: "이 카드도 계속 확인해 줘.",
              },
            ],
          }),
          model: "gpt-5.6-luna",
          latencyMs: 1,
          attempts: 1,
        }),
      },
      eventHub: new RuntimeSessionEventHub(),
      storyFolder: { foldIfNeeded },
      instructionCommandSender,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([nodeEvent("node-a", "session-a", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(repository.appendSummary).toHaveBeenCalledWith(
      "session-a",
      expect.objectContaining({ content: "카드 확인을 한 번 요청했다." }),
      "turn_summary:10:19",
    );
    expect(foldIfNeeded).toHaveBeenCalledWith("session-a");
    expect(instructionCommandSender).not.toHaveBeenCalled();
  });

  it("uses the raw PAS response as the summary when structured parsing fails", async () => {
    const repository = fakeRepository();
    repository.loadTurn.mockResolvedValue({
      sessionId: "session-a",
      folderId: "allowed-folder",
      metadata: [
        { type: "caller_info", value: { source: "browser" } },
        { type: "persistent_session", value: { enabled: true } },
      ],
      turnStartEventId: 10,
      finalResponseEventId: 19,
      userText: "앞으로 간결하게 답해 줘.",
      assistantText: "알겠습니다.",
      startEvidence: { kind: "user_message", evidenceState: "complete" },
      speaker: { kind: "user", displayName: "사용자", source: "browser" },
    });
    const rawResponse = "모델이 JSON이 아닌 응답을 반환했다.";
    const instructionCommandSender = vi.fn();
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer: {
        summarize: vi.fn().mockResolvedValue({
          content: rawResponse,
          model: "gpt-5.6-luna",
          latencyMs: 1,
          attempts: 1,
        }),
      },
      eventHub: new RuntimeSessionEventHub(),
      instructionCommandSender,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([nodeEvent("node-a", "session-a", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(repository.appendSummary).toHaveBeenCalledWith(
      "session-a",
      expect.objectContaining({ content: rawResponse }),
      "turn_summary:10:19",
    );
    expect(repository.countTurnSummariesThrough).not.toHaveBeenCalled();
    expect(instructionCommandSender).not.toHaveBeenCalled();
  });

  it("omits the H1 anchor when the input event has no input_id", async () => {
    const repository = fakeRepository();
    repository.loadTurn.mockResolvedValue({
      sessionId: "session-a",
      folderId: "allowed-folder",
      metadata: [
        { type: "caller_info", value: { source: "soul-app" } },
        { type: "persistent_session", value: { enabled: true } },
      ],
      turnStartEventId: 10,
      finalResponseEventId: 19,
      userText: "앞으로 간결하게 답해 줘.",
      assistantText: "알겠습니다.",
      startEvidence: { kind: "user_message", evidenceState: "complete" },
      speaker: { kind: "user", displayName: "사용자", source: "soul-app" },
    });
    repository.countTurnSummariesThrough.mockResolvedValue(5);
    const instructionCommandSender = vi.fn();
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer: {
        summarize: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            summary: "선호를 기록했다.",
            standing_instructions: [{
              text: "간결하게 답해 줘.",
              confidence: 0.9,
              existing_id: null,
              source_quote: "앞으로 간결하게 답해 줘.",
            }],
          }),
          model: "gpt-5.6-luna",
          latencyMs: 1,
          attempts: 1,
        }),
      },
      eventHub: new RuntimeSessionEventHub(),
      instructionCommandSender,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([nodeEvent("node-a", "session-a", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(instructionCommandSender).toHaveBeenCalledWith(
      expect.not.objectContaining({ anchor: expect.anything() }),
    );
  });

  it("reduces the measured 15-turn fixture to nine complete store-and-fold paths", async () => {
    const repository = fakeRepository();
    const fixture = measuredFifteenTurnFixture();
    repository.loadTurn.mockImplementation(async (_sessionId, completeEventId) => {
      const turn = fixture.find((candidate) =>
        candidate.completeEventId === completeEventId
      );
      if (turn === undefined) return null;
      return {
        sessionId: "parent-session",
        folderId: "allowed-folder",
        metadata: [{ type: "caller_info", value: { source: "browser" } }],
        turnStartEventId: turn.turn,
        finalResponseEventId: turn.completeEventId - 1,
        userText: `turn-${turn.turn}`,
        assistantText: `response-${turn.turn}`,
        startEvidence: turn.startEvidence,
      };
    });
    let persistedTurn = 0;
    const appendedTurns: number[] = [];
    repository.appendSummary.mockImplementation(async (_sessionId, payload) => {
      persistedTurn = Number(payload.turn_start_event_id);
      appendedTurns.push(persistedTurn);
      return { inserted: true, eventId: 10_000 + persistedTurn };
    });
    repository.loadGapEvents.mockResolvedValue([]);
    const foldedTurns: number[] = [];
    const foldIfNeeded = vi.fn().mockImplementation(async () => {
      foldedTurns.push(persistedTurn);
    });
    const summarize = vi.fn().mockImplementation(async ({ userText }) => ({
      content: `summary-${userText}`,
      model: "gpt-5.6-terra",
      latencyMs: 1,
      attempts: 1,
    }));
    const debug = vi.fn();
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer: { summarize },
      eventHub: new RuntimeSessionEventHub(),
      storyFolder: { foldIfNeeded },
      logger: { debug, info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept(fixture.map((turn) =>
      nodeEvent("node-a", "parent-session", {
        type: "complete",
        _event_id: turn.completeEventId,
      })
    ));
    await pipeline.drain();

    const included = [1, 2, 3, 4, 6, 7, 8, 10, 13];
    const excluded = [5, 9, 11, 12, 14, 15];
    expect(summarize.mock.calls.map((call) => call[0].userText)).toEqual(
      included.map((turn) => `turn-${turn}`),
    );
    expect(appendedTurns).toEqual(included);
    expect(foldedTurns).toEqual(included);
    expect(summarize).toHaveBeenCalledTimes(9);
    expect(repository.appendSummary).toHaveBeenCalledTimes(9);
    expect(foldIfNeeded).toHaveBeenCalledTimes(9);
    for (const turn of excluded) {
      expect(summarize.mock.calls).not.toContainEqual([
        expect.objectContaining({ userText: `turn-${turn}` }),
        expect.anything(),
      ]);
      expect(appendedTurns).not.toContain(turn);
      expect(foldedTurns).not.toContain(turn);
    }
  });

  it.each([
    [
      completionEvidence({ currentRevision: 1_207, currentTerminalStatus: "error" }),
      "delegated_terminal_failure",
    ],
    [
      completionEvidence({
        currentRevision: 200,
        previousCompletedRevision: 169,
        hasNewExternalInput: false,
      }),
      "delegated_completion_without_new_input",
    ],
  ])("logs complete structural evidence for %s", async (
    startEvidence,
    reason,
  ) => {
    const repository = fakeRepository();
    repository.loadTurn.mockResolvedValue({
      sessionId: "parent-session",
      folderId: "allowed-folder",
      metadata: [{ type: "caller_info", value: { source: "browser" } }],
      turnStartEventId: 10,
      finalResponseEventId: 19,
      userText: "위임 결과",
      assistantText: "처리 결과",
      startEvidence,
    });
    const debug = vi.fn();
    const summarizer = { summarize: vi.fn() } satisfies TurnSummarizer;
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer,
      eventHub: new RuntimeSessionEventHub(),
      logger: { debug, info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([nodeEvent("node-a", "parent-session", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: "child-a",
        currentRevision: startEvidence.currentRevision,
        previousCompletedRevision: startEvidence.previousCompletedRevision,
        evidenceState: "complete",
        reason,
      }),
      "Turn summary skipped",
    );
    expect(summarizer.summarize).not.toHaveBeenCalled();
    expect(repository.appendSummary).not.toHaveBeenCalled();
  });

  it("logs null relation fields for a non-completion system notification", async () => {
    const repository = fakeRepository();
    repository.loadTurn.mockResolvedValue({
      sessionId: "parent-session",
      folderId: "allowed-folder",
      metadata: [{ type: "caller_info", value: { source: "browser" } }],
      turnStartEventId: 10,
      finalResponseEventId: 19,
      userText: "정리 후속",
      assistantText: "이미 완료됐다.",
      startEvidence: {
        kind: "system_notification",
        evidenceState: "complete",
      },
    });
    const debug = vi.fn();
    const pipeline = new TurnSummaryPipeline({
      repository,
      configService: { read: () => CONFIG },
      summarizer: { summarize: vi.fn() },
      eventHub: new RuntimeSessionEventHub(),
      logger: { debug, info: vi.fn(), warn: vi.fn() },
    });

    pipeline.accept([nodeEvent("node-a", "parent-session", {
      type: "complete",
      _event_id: 20,
    })]);
    await pipeline.drain();

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: null,
        currentRevision: null,
        previousCompletedRevision: null,
        evidenceState: "complete",
        reason: "system_notification",
      }),
      "Turn summary skipped",
    );
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
        startEvidence: { kind: "user_message", evidenceState: "complete" },
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
        startEvidence: { kind: "user_message", evidenceState: "complete" },
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
    countTurnSummariesThrough: vi.fn().mockResolvedValue(1),
    isSessionSummarizable: vi.fn().mockResolvedValue(true),
    appendSummary: vi.fn().mockResolvedValue({ inserted: true, eventId: 22 }),
    loadGapEvents: vi.fn().mockResolvedValue([{
      type: "event",
      agentSessionId: "session-a",
      event: { type: "progress", _event_id: 21, text: "late" },
    }]),
  } satisfies Record<keyof TurnSummaryRepositoryPort, ReturnType<typeof vi.fn>>;
}

function completionEvidence(overrides: Record<string, unknown> = {}) {
  return {
    kind: "completion_notification" as const,
    evidenceState: "complete" as const,
    childSessionId: "child-a",
    currentRevision: 1_038,
    previousCompletedRevision: 381,
    currentTerminalStatus: "completed",
    hasNewExternalInput: true,
    ...overrides,
  };
}

function measuredFifteenTurnFixture() {
  return [
    { turn: 1, completeEventId: 100, startEvidence: { kind: "user_message" as const, evidenceState: "complete" as const } },
    { turn: 2, completeEventId: 200, startEvidence: completionEvidence({ currentRevision: 381, previousCompletedRevision: null }) },
    { turn: 3, completeEventId: 300, startEvidence: completionEvidence({ currentRevision: 1_038, previousCompletedRevision: 381 }) },
    { turn: 4, completeEventId: 400, startEvidence: completionEvidence({ currentRevision: 1_203, previousCompletedRevision: 1_038 }) },
    { turn: 5, completeEventId: 500, startEvidence: completionEvidence({ currentRevision: 1_207, previousCompletedRevision: 1_203, currentTerminalStatus: "error", hasNewExternalInput: false }) },
    { turn: 6, completeEventId: 600, startEvidence: completionEvidence({ currentRevision: 1_726, previousCompletedRevision: 1_203 }) },
    { turn: 7, completeEventId: 700, startEvidence: completionEvidence({ currentRevision: 1_811, previousCompletedRevision: 1_726 }) },
    { turn: 8, completeEventId: 800, startEvidence: completionEvidence({ currentRevision: 2_326, previousCompletedRevision: 1_811 }) },
    { turn: 9, completeEventId: 900, startEvidence: completionEvidence({ currentRevision: 2_330, previousCompletedRevision: 2_326, currentTerminalStatus: "error", hasNewExternalInput: false }) },
    { turn: 10, completeEventId: 1_000, startEvidence: completionEvidence({ currentRevision: 2_466, previousCompletedRevision: 2_326 }) },
    { turn: 11, completeEventId: 1_100, startEvidence: completionEvidence({ currentRevision: 2_470, previousCompletedRevision: 2_466, currentTerminalStatus: "error", hasNewExternalInput: false }) },
    { turn: 12, completeEventId: 1_200, startEvidence: completionEvidence({ currentRevision: 2_474, previousCompletedRevision: 2_466, currentTerminalStatus: "error", hasNewExternalInput: false }) },
    { turn: 13, completeEventId: 1_300, startEvidence: completionEvidence({ childSessionId: "child-b", currentRevision: 169, previousCompletedRevision: null }) },
    { turn: 14, completeEventId: 1_400, startEvidence: completionEvidence({ childSessionId: "child-b", currentRevision: 187, previousCompletedRevision: 169, hasNewExternalInput: false }) },
    { turn: 15, completeEventId: 1_500, startEvidence: completionEvidence({ childSessionId: "child-b", currentRevision: 200, previousCompletedRevision: 169, hasNewExternalInput: false }) },
  ];
}
