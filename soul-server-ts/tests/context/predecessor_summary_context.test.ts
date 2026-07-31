import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { buildPredecessorSummaryContextItem } from
  "../../src/context/predecessor_summary_context.js";
import { buildSessionTurnExcerpt } from
  "../../src/context/session_turn_summary.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type {
  SessionStoryTurnSummary,
  SessionStoryView,
} from "../../src/db/repositories/session_story_repository.js";

const CURRENT_SESSION_ID = "sess-current";
const PREDECESSOR_SESSION_ID = "sess-previous";

describe("buildPredecessorSummaryContextItem", () => {
  it("injects the digest narrative and every unfolded summary in time order", async () => {
    const story = makeStory({
      narrative: "[T1-T5] 서버 계약을 확정했다.",
      narrativeThroughEventId: 50,
      unfoldedTurnSummaries: [
        makeSummary(61, 6, "위임 세션의 단계 3 통과 상태를 보존했다."),
        makeSummary(72, 7, "검증 결과를 반영했다."),
      ],
    });
    const db = makeDb({ story, awaySummary: "기존 away summary" });

    const payload = await buildPayload(db);

    expect(payload).toEqual({
      session_id: PREDECESSOR_SESSION_ID,
      source: "session_story",
      narrative: "[T1-T5] 서버 계약을 확정했다.",
      unfolded_turn_summaries: [
        expect.objectContaining({
          event_id: 61,
          turn_number: 6,
          content: "위임 세션의 단계 3 통과 상태를 보존했다.",
        }),
        expect.objectContaining({
          event_id: 72,
          turn_number: 7,
          content: "검증 결과를 반영했다.",
        }),
      ],
    });
    expect(db.getSessionStory).toHaveBeenCalledWith(PREDECESSOR_SESSION_ID);
    expect(db.countEvents).not.toHaveBeenCalled();
  });

  it("keeps a just-folded story when no unfolded summaries remain", async () => {
    const db = makeDb({
      story: makeStory({
        narrative: "[T1-T10] 구현과 검증을 마쳤다.",
        narrativeThroughEventId: 100,
      }),
    });

    await expect(buildPayload(db)).resolves.toEqual({
      session_id: PREDECESSOR_SESSION_ID,
      source: "session_story",
      narrative: "[T1-T10] 구현과 검증을 마쳤다.",
      unfolded_turn_summaries: [],
    });
  });

  it("caps no-digest legacy summaries at the latest 30 and snapshots payload growth", async () => {
    const summaries = Array.from(
      { length: 35 },
      (_, index) => makeSummary(
        (index + 1) * 10,
        index + 1,
        `턴 ${index + 1}에서 ${"결정을 확정했다. ".repeat(4)}`.trim(),
      ),
    );
    const legacyEvents = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      event_type: index % 2 === 0 ? "user_message" : "assistant_message",
      payload: { text: "기존 상세 응답 ".repeat(80) },
      created_at: new Date(1_785_427_200_000 + index * 1_000),
    }));
    const db = makeDb({
      story: makeStory({ unfoldedTurnSummaries: summaries }),
      totalEvents: legacyEvents.length,
      legacyEvents,
    });

    const item = await buildPredecessorSummaryContextItem(
      db,
      makeLogger(),
      CURRENT_SESSION_ID,
    );
    const payload = JSON.parse(String(item?.content)) as {
      source: string;
      omitted_turns_notice: string;
      unfolded_turn_summaries: Array<{ turn_number: number }>;
    };
    const legacyExcerpt = await buildSessionTurnExcerpt(
      db,
      PREDECESSOR_SESSION_ID,
    );
    const legacyContent = JSON.stringify({
      session_id: PREDECESSOR_SESSION_ID,
      source: "turn_excerpt",
      ...legacyExcerpt,
    }, null, 2);

    expect(payload.unfolded_turn_summaries.map(
      (summary) => summary.turn_number,
    )).toEqual(Array.from({ length: 30 }, (_, index) => index + 6));
    expect({
      source: payload.source,
      omitted_turns_notice: payload.omitted_turns_notice,
      injected_chars: String(item?.content).length,
      legacy_excerpt_chars: legacyContent.length,
      injected_is_smaller: String(item?.content).length < legacyContent.length,
    }).toMatchInlineSnapshot(`
      {
        "injected_chars": 7526,
        "injected_is_smaller": true,
        "legacy_excerpt_chars": 128094,
        "omitted_turns_notice": "이전 5턴 생략",
        "source": "turn_summaries",
      }
    `);
  });

  it("falls back to the existing turn excerpt when no story data exists", async () => {
    const db = makeDb({
      totalEvents: 1,
      legacyEvents: [{
        id: 7,
        event_type: "assistant_message",
        payload: { text: "완료 내용" },
        created_at: new Date("2026-07-14T00:00:00.000Z"),
      }],
    });

    await expect(buildPayload(db)).resolves.toMatchObject({
      session_id: PREDECESSOR_SESSION_ID,
      source: "turn_excerpt",
      totalEvents: 1,
      turns: [{ event_id: 7, text: "완료 내용" }],
    });
  });

  it("warns and degrades to the turn excerpt when story lookup fails", async () => {
    const logger = makeLogger();
    const db = makeDb({
      storyError: new Error("session_digests unavailable"),
      totalEvents: 1,
      legacyEvents: [{
        id: 9,
        event_type: "user_message",
        payload: { text: "이전 요청" },
        created_at: new Date("2026-07-14T00:00:00.000Z"),
      }],
    });

    const item = await buildPredecessorSummaryContextItem(
      db,
      logger,
      CURRENT_SESSION_ID,
    );

    expect(JSON.parse(String(item?.content))).toMatchObject({
      source: "turn_excerpt",
      turns: [{ event_id: 9, text: "이전 요청" }],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: CURRENT_SESSION_ID,
        predecessorSessionId: PREDECESSOR_SESSION_ID,
      }),
      "Failed to read predecessor session story; using turn excerpt",
    );
  });
});

async function buildPayload(db: SessionDB): Promise<Record<string, unknown>> {
  const item = await buildPredecessorSummaryContextItem(
    db,
    makeLogger(),
    CURRENT_SESSION_ID,
  );
  return JSON.parse(String(item?.content)) as Record<string, unknown>;
}

function makeDb(options: {
  story?: SessionStoryView;
  storyError?: Error;
  awaySummary?: string | null;
  totalEvents?: number;
  legacyEvents?: Array<{
    id: number;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>;
} = {}): SessionDB {
  const getSession = vi.fn(async (sessionId: string) =>
    sessionId === CURRENT_SESSION_ID
      ? {
          session_id: sessionId,
          predecessor_session_id: PREDECESSOR_SESSION_ID,
          folder_id: null,
        }
      : {
          session_id: sessionId,
          predecessor_session_id: null,
          folder_id: null,
          away_summary: options.awaySummary ?? null,
        });
  const getSessionStory = options.storyError
    ? vi.fn().mockRejectedValue(options.storyError)
    : vi.fn().mockResolvedValue(options.story ?? makeStory());
  return {
    getSession,
    getSessionStory,
    countEvents: vi.fn().mockResolvedValue(options.totalEvents ?? 0),
    readEvents: vi.fn().mockResolvedValue(options.legacyEvents ?? []),
  } as unknown as SessionDB;
}

function makeStory(
  overrides: Partial<SessionStoryView> = {},
): SessionStoryView {
  return {
    highlight: null,
    narrative: null,
    unfoldedTurnSummaries: [],
    narrativeThroughEventId: null,
    foldCount: 0,
    updatedAt: null,
    ...overrides,
  };
}

function makeSummary(
  eventId: number,
  turnNumber: number,
  content: string,
): SessionStoryTurnSummary {
  return {
    eventId,
    turnNumber,
    content,
    turnStartEventId: eventId - 2,
    finalResponseEventId: eventId - 1,
    createdAt: new Date(1_785_427_200_000 + eventId * 1_000),
  };
}

function makeLogger(): Logger {
  return {
    warn: vi.fn(),
  } as unknown as Logger;
}
