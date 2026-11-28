import { createI18n } from "@soulstream/i18n";
import { describe, expect, it } from "vitest";
import type { CardComment, CardDetail, CardQuestion, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import {
  buildThread as buildLocalizedThread, cardAgenda, entryAgenda, formatReturnTime, groupAgendas, openQuestionOf, type ReportEntry,
} from "./pas-report-thread-model";

const card = (patch: Partial<CardRow> & { id: string }): CardRow => ({
  number: 1, folderId: "f", title: "제목", request: "요청", brief: "", attachments: [], status: "review", blockedKind: null, blockedDetail: null,
  positionKey: "a", queuePositionKey: null, assigneeKind: "agent", assigneeAgentId: "roselin", assigneeUserId: null, assigneeSessionId: "s-main",
  nodeId: null, modelPreset: null, version: 1, archived: false, createdAt: "2026-11-25T01:00:00.000Z", updatedAt: "2026-11-25T02:00:00.000Z", ...patch,
}) as CardRow;
const entry = (patch: Partial<ReportEntry> & { key: string }): ReportEntry => ({
  kind: "see", title: "장 제목", card_numbers: [7], context: "", action: "", options: [], state: "open", answer: "", updated_at: "2026-11-25T02:00:00.000Z",
  card_id: "c1", card_status: "review", ...patch,
}) as ReportEntry;
const comment = (patch: Partial<CardComment> & { id: string; createdAt: string }): CardComment => ({
  cardId: "c1", authorKind: "user", authorId: "u", sessionId: null, kind: "comment", body: "글", ...patch,
});

describe("entryAgenda", () => {
  it("판의 장을 데이터로 종류를 가른다", () => {
    expect(entryAgenda(entry({ key: "cq_a", question_kind: "choice" }), undefined)?.kind).toBe("question");
    expect(entryAgenda(entry({ key: "cq_a", question_kind: "request" }), undefined)?.kind).toBe("request");
    expect(entryAgenda(entry({ key: "card_c1" }), card({ id: "c1", status: "review" }))?.kind).toBe("review");
    expect(entryAgenda(entry({ key: "card_c1", card_status: "blocked" }), undefined)?.kind).toBe("blocked");
    expect(entryAgenda(entry({ key: "card_c1" }), card({ id: "c1", status: "awaiting_verification" }))?.kind).toBe("verifying");
  });
  it("card_id가 없는 PAS 자체 장과 답한 질문 장, 끝난 카드는 안건이 아니다", () => {
    expect(entryAgenda(entry({ key: "x", card_id: undefined }), undefined)).toBeNull();
    expect(entryAgenda(entry({ key: "cq_a", state: "answered" }), undefined)).toBeNull();
    expect(entryAgenda(entry({ key: "card_c1" }), card({ id: "c1", status: "done" }))).toBeNull();
  });
  it("카드의 snoozedUntil을 읽고, 없는 응답에서도 깨지지 않는다", () => {
    expect(entryAgenda(entry({ key: "card_c1" }), card({ id: "c1", snoozedUntil: "2026-11-26T00:00:00.000Z" }))?.snoozedUntil).toBe(Date.parse("2026-11-26T00:00:00.000Z"));
    expect(entryAgenda(entry({ key: "card_c1" }), card({ id: "c1" }))?.snoozedUntil).toBeNull();
    expect(entryAgenda(entry({ key: "card_c1" }), card({ id: "c1", snoozedUntil: "아님" }))?.snoozedUntil).toBeNull();
  });
});

describe("groupAgendas", () => {
  const now = Date.parse("2026-11-25T12:00:00.000Z");
  const board = [
    entryAgenda(entry({ key: "card_a", card_id: "a" }), card({ id: "a", number: 1 }))!,
    entryAgenda(entry({ key: "card_b", card_id: "b" }), card({ id: "b", number: 2, snoozedUntil: "2026-11-25T15:00:00.000Z" }))!,
    entryAgenda(entry({ key: "card_c", card_id: "c" }), card({ id: "c", number: 3, snoozedUntil: "2026-11-25T11:00:00.000Z" }))!,
  ];
  const cards = [
    card({ id: "a", status: "review" }), card({ id: "r1", status: "running", updatedAt: "2026-11-25T03:00:00.000Z" }),
    card({ id: "r2", status: "awaiting_verification", updatedAt: "2026-11-25T05:00:00.000Z" }), card({ id: "r3", status: "queued" }),
    card({ id: "h1", status: "on_hold" }), card({ id: "h2", status: "on_hold" }),
  ];
  const groups = groupAgendas(board, cards, now);
  it("미룬 것만 미뤄 둠으로 가고, 지난 시각은 결재 대기로 돌아온다", () => {
    expect(groups.snoozed.map(agenda => agenda.cardId)).toEqual(["b"]);
    expect(groups.pending.map(agenda => agenda.cardId)).toEqual(["a", "c"]);
  });
  it("진행 중은 running과 검증 대기 가운데 결재 대기에 없는 것을 최근 갱신 순으로 둔다", () => {
    expect(groups.running.map(agenda => [agenda.cardId, agenda.kind])).toEqual([["r2", "verifying"], ["r1", "running"]]);
  });
  it("보류함 개수는 on_hold 카드 수다", () => {
    expect(groups.holdCount).toBe(2);
  });
  it("진행 중이 아닌 카드는 안건이 되지 않는다", () => {
    expect(cardAgenda(card({ id: "q", status: "queued" }))).toBeNull();
  });
});

const { t } = createI18n("ko");
const buildThread = (cardDetail: CardDetail) => buildLocalizedThread(cardDetail, t);

describe("formatReturnTime", () => {
  const now = new Date(2026, 10, 25, 10, 0).getTime();
  it("오늘은 시각, 내일은 「내일」, 그 뒤는 월/일을 붙인다", () => {
    expect(formatReturnTime(new Date(2026, 10, 25, 19, 0).getTime(), now, t, "ko")).toBe("19:00");
    expect(formatReturnTime(new Date(2026, 10, 26, 9, 5).getTime(), now, t, "ko")).toBe("내일 09:05");
    expect(formatReturnTime(new Date(2026, 10, 28, 9, 0).getTime(), now, t, "ko")).toBe(new Intl.DateTimeFormat("ko", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(2026, 10, 28, 9, 0)));
  });
});

describe("buildThread", () => {
  const question: CardQuestion = { id: "q1", text: "어느 쪽?", options: ["가", "나"], answer: null, askedAt: "2026-11-25T03:00:00.000Z", answeredAt: null };
  const detail = (patch: Partial<CardDetail> = {}): CardDetail => ({
    card: card({ id: "c1" }), reports: [], questions: [], sessions: [], comments: [], notes: [], nowHistory: [], ...patch,
  });
  it("원 요청, 이정표, 커멘트를 시간순으로 한 줄기에 둔다", () => {
    const thread = buildThread(detail({
      nowHistory: [{ text: "조사 중", turn: "agent", ask: null, at: "2026-11-25T01:30:00.000Z" }],
      statusHistory: [{ status: "review", at: "2026-11-25T01:45:00.000Z", actorKind: "agent", sessionId: "s-main" }],
      sessions: [
        { sessionId: "s-main", cardId: "c1", displayName: null, nodeId: "n", agentId: "roselin", status: "running", createdAt: "2026-11-25T01:10:00.000Z", callerSessionId: null, updatedAt: "" },
        { sessionId: "s-sub", cardId: "c1", displayName: null, nodeId: "n", agentId: "selaphiel", agentName: "세라피엘", status: "running", createdAt: "2026-11-25T01:20:00.000Z", callerSessionId: "s-main", updatedAt: "" },
      ],
      comments: [comment({ id: "m1", createdAt: "2026-11-25T01:50:00.000Z" })],
    }));
    expect(thread.map(item => item.kind === "milestone" ? `milestone:${item.text}` : item.kind)).toEqual([
      "request", "milestone:위임: 세라피엘", "milestone:조사 중", "milestone:상태: 검수 대기", "comments",
    ]);
  });
  it("statusHistory가 없는 응답은 그 이정표만 뺀다", () => {
    const thread = buildThread(detail({ nowHistory: [{ text: "조사 중", turn: "agent", ask: null, at: "2026-11-25T01:30:00.000Z" }] }));
    expect(thread.filter(item => item.kind === "milestone")).toHaveLength(1);
  });
  it("노트는 이어진 것끼리 한 덩이로 묶고, 사이에 커멘트가 끼면 나눈다", () => {
    const thread = buildThread(detail({ comments: [
      comment({ id: "n1", createdAt: "2026-11-25T02:00:00.000Z", kind: "note", authorKind: "agent" }),
      comment({ id: "n2", createdAt: "2026-11-25T02:01:00.000Z", kind: "note", authorKind: "agent" }),
      comment({ id: "m1", createdAt: "2026-11-25T02:02:00.000Z" }),
      comment({ id: "n3", createdAt: "2026-11-25T02:03:00.000Z", kind: "note", authorKind: "agent" }),
    ] }));
    expect(thread.map(item => item.kind === "notes" ? `notes:${item.notes.length}` : item.kind)).toEqual(["request", "notes:2", "comments", "notes:1"]);
  });
  it("질문 글타래의 커멘트는 질문 블록에 두고 따로 세우지 않는다", () => {
    const thread = buildThread(detail({ questions: [question], comments: [comment({ id: "t1", createdAt: "2026-11-25T03:05:00.000Z", questionId: "q1" })] }));
    expect(thread.map(item => item.kind)).toEqual(["request", "question"]);
  });
  it("같은 상황판 문구는 한 번만 둔다", () => {
    const entry = { text: "같음", turn: "agent" as const, ask: null, at: "2026-11-25T01:30:00.000Z" };
    expect(buildThread(detail({ nowHistory: [entry, entry] })).filter(item => item.kind === "milestone")).toHaveLength(1);
  });
});

describe("질문과 항목 지시", () => {
  it("열린 질문을 찾고, 답한 질문은 열린 것으로 치지 않는다", () => {
    const open: CardQuestion = { id: "q1", text: "?", options: null, answer: null, askedAt: "t", answeredAt: null };
    const answered: CardQuestion = { ...open, id: "q0", answer: "응", answeredAt: "t" };
    const detail = { card: card({ id: "c1" }), reports: [], questions: [answered, open], sessions: [] } as CardDetail;
    expect(openQuestionOf(detail, null)?.id).toBe("q1");
    expect(openQuestionOf(undefined, null)).toBeNull();
  });
});
