import type { CardCheckItem, CardComment, CardDetail, CardQuestion, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { CARD_QUESTION_KEY_PREFIX, type PersistentReportEntry } from "../../../../packages/wire-schema/src/persistent_report";

/**
 * 보고 창 견본과 화면 시험이 함께 쓰는 운영 형태 표본: 긴 제목, 질문(선택지와 부탁), 검수, 막힘, 진행 중, 미뤄 둠.
 * 시각은 기준 시각에서 거꾸로 센다. 미뤄 둠의 되돌아올 시각은 기준 시각보다 뒤다.
 */
export interface PasThreadFixture {
  cards: Record<string, CardRow>;
  details: Record<string, CardDetail>;
  entries: PersistentReportEntry[];
  /** 카드 목록(GET /api/cards?includeCompleted=false)이 돌려줄 카드. */
  list: CardRow[];
}

export const PAS_THREAD_IDS = {
  review: "pas-rt-card-review", question: "pas-rt-card-question", request: "pas-rt-card-request",
  blocked: "pas-rt-card-blocked", running: "pas-rt-card-running", verifying: "pas-rt-card-verifying", snoozed: "pas-rt-card-snoozed",
} as const;

const minutes = (base: number, back: number) => new Date(base - back * 60_000).toISOString();

export function buildPasThreadFixture(base = Date.now()): PasThreadFixture {
  const card = (id: string, number: number, title: string, status: CardRow["status"], patch: Partial<CardRow> = {}): CardRow => ({
    id, number, folderId: "pas-rt-folder", title, request: `${title}\n\n요청 원문입니다. 화면과 동작을 운영 데이터 모양으로 확인합니다.`, brief: "",
    attachments: [], status, blockedKind: null, blockedDetail: null, positionKey: id, queuePositionKey: null,
    assigneeKind: "session", assigneeAgentId: "roselin", assigneeUserId: null, assigneeSessionId: `${id}-session`,
    nodeId: "eiaserinnys", modelPreset: null, version: 3, archived: false, createdAt: minutes(base, 600), updatedAt: minutes(base, 12), items: [], now: null, ...patch,
  });
  const item = (id: number, title: string, patch: Partial<CardCheckItem> = {}): CardCheckItem => ({
    id, title, state: "done", result: null, evidence: [], caveat: null, rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null,
    createdAt: minutes(base, 300), reportedAt: minutes(base, 40), display: "reported", ...patch,
  });
  const comment = (id: string, cardId: string, back: number, patch: Partial<CardComment>): CardComment => ({
    id, cardId, authorKind: "user", authorId: "director", sessionId: null, kind: "comment", body: "", createdAt: minutes(base, back), ...patch,
  });
  const longReview = "PAS 결재형 보고 창 구현 — 시간순 사건 스레드와 안건 레일, 답변 미루기, 카드 패널 열기까지 한 번에 확인하는 아주 긴 제목";
  const reviewItems = [
    item(1, "레일과 스레드가 같은 안건을 가리킨다", { result: "넓은 폭과 좁은 폭에서 같은 안건이 열린다.",
      evidence: [{ type: "image", url: "/icon-192.png", label: "결재 대기 화면" }] }),
    item(2, "답변 미루기 뒤 미뤄 둠 묶음으로 이동한다", { result: "미룬 안건이 미뤄 둠에 모이고 시각이 보인다.", caveat: "서버 단위가 배포되기 전에는 가짜 응답으로만 봤다." }),
    item(3, "위로 올리면 최신 경과 알약이 뜬다", { state: "doing", display: "doing", result: null, reportedAt: null }),
  ];
  const review = card(PAS_THREAD_IDS.review, 1871, longReview, "review", {
    items: reviewItems, now: { text: "화면 시험을 마치고 검수를 요청합니다.", turn: "user", ask: null, updatedAt: minutes(base, 12), sessionId: null },
  });
  const questionText = "카드 의존 관계를 웹 목록에서 어떻게 보여 줄까요? 아래 두 가지 중 하나를 고르면 그대로 구현합니다.";
  const question = card(PAS_THREAD_IDS.question, 1865, "카드 의존 관계 표시 방식을 골라 주세요", "blocked", { blockedKind: "question",
    items: [item(1, "의존 관계 표시안이 시안과 같다", { result: "목록 행 아래 한 줄로 그렸다." })] });
  const request = card(PAS_THREAD_IDS.request, 1862, "이 PC에서 인증 코드를 다시 보내 주세요", "blocked", { blockedKind: "question" });
  const blocked = card(PAS_THREAD_IDS.blocked, 1844, "배포 검증이 한도에 막혀 멈춤", "blocked", { blockedKind: "limit", blockedDetail: "모델 한도 대기" });
  const running = card(PAS_THREAD_IDS.running, 1859, "앱 보고 화면 구현", "running", { updatedAt: minutes(base, 3) });
  const verifying = card(PAS_THREAD_IDS.verifying, 1860, "서버 배포 뒤 노드 연결 확인", "awaiting_verification", { updatedAt: minutes(base, 30), waitingFor: "배포 완료" });
  const snoozed = card(PAS_THREAD_IDS.snoozed, 1833, "주간 회고 초안 검수", "review", { snoozedUntil: new Date(base + 20 * 3600_000).toISOString() });
  const hold = (n: number) => card(`pas-rt-card-hold-${n}`, 1800 + n, `보류한 카드 ${n}`, "on_hold");
  const cards = Object.fromEntries([review, question, request, blocked, running, verifying, snoozed, hold(1), hold(2), hold(3)].map(row => [row.id, row]));
  const choice: CardQuestion = {
    id: "pas-rt-question-1", text: questionText, options: ["카드 안에 줄로 보여 주기", "별도 그래프로 보여 주기"], answer: null,
    askedAt: minutes(base, 20), answeredAt: null, title: "의존 관계 표시", kind: "choice",
    optionDetails: [
      { label: "카드 안에 줄로 보여 주기", description: "카드 행 아래에 기다리는 카드 번호를 한 줄로 적는다. 구현이 작다.", recommended: true },
      { label: "별도 그래프로 보여 주기", description: "보드 위에 화살표 그래프를 그린다. 카드가 많으면 읽기 어렵다.", recommended: false },
    ],
  };
  const ask: CardQuestion = {
    id: "pas-rt-question-2", text: "인증 코드가 만료됐습니다. 이 PC에서 새 코드를 받아 채팅으로 보내 주세요.", options: null, answer: null,
    askedAt: minutes(base, 8), answeredAt: null, title: "인증 코드 다시 받기", kind: "request",
  };
  const answeredEarlier: CardQuestion = {
    id: "pas-rt-question-0", text: "이전 방식으로 계속할까요?", options: ["계속", "바꾸기"], answer: "계속", askedAt: minutes(base, 180), answeredAt: minutes(base, 170),
    title: "진행 방식", kind: "choice", selectedOption: "계속",
  };
  const sessions = (id: string, extra = false): CardDetail["sessions"] => [
    { sessionId: `${id}-session`, cardId: id, displayName: null, nodeId: "eiaserinnys", agentId: "roselin", agentName: "로젤린", status: "running", createdAt: minutes(base, 590), callerSessionId: null, updatedAt: minutes(base, 12) },
    ...(extra ? [{ sessionId: `${id}-review`, cardId: id, displayName: null, nodeId: "eiaserinnys", agentId: "selaphiel", agentName: "세라피엘", status: "completed" as const, createdAt: minutes(base, 90), callerSessionId: `${id}-session`, updatedAt: minutes(base, 60) }] : []),
  ];
  const detail = (row: CardRow, patch: Partial<CardDetail> = {}): CardDetail => ({ card: row, reports: [], questions: [], sessions: sessions(row.id), comments: [], notes: [], nowHistory: [], statusHistory: [], ...patch });
  const details: Record<string, CardDetail> = {
    [review.id]: detail(review, {
      sessions: sessions(review.id, true),
      nowHistory: [
        { text: "시안 부품을 옮기는 중입니다.", turn: "agent", ask: null, at: minutes(base, 400) },
        { text: "레일과 결재 상자를 연결했습니다.", turn: "agent", ask: null, at: minutes(base, 200) },
        { text: "화면 시험을 마치고 검수를 요청합니다.", turn: "user", ask: null, at: minutes(base, 12) },
      ],
      statusHistory: [
        { status: "running", at: minutes(base, 590), actorKind: "agent", sessionId: `${review.id}-session` },
        { status: "review", at: minutes(base, 12), actorKind: "agent", sessionId: `${review.id}-session` },
      ],
      comments: [
        comment("c-1", review.id, 500, { body: "시안 r11 그대로 가고, 레일 시작선은 맞춰 주세요." }),
        comment("c-2", review.id, 480, { authorKind: "agent", authorId: "roselin", sessionId: `${review.id}-session`, body: "알겠습니다. 시작선과 구역 간격을 시안과 같게 맞추겠습니다." }),
        comment("n-1", review.id, 300, { authorKind: "agent", authorId: "roselin", kind: "note", body: "baseline 확인: 6e8d1c4" }),
        comment("n-2", review.id, 299, { authorKind: "agent", authorId: "roselin", kind: "note", body: "typecheck 통과 로그 정리" }),
        comment("c-3", review.id, 14, { authorKind: "agent", authorId: "roselin", sessionId: `${review.id}-session`,
          body: "결과 보고입니다. 넓은 폭과 좁은 폭의 결재 대기, 서랍, 답변 미루기를 확인했습니다. 확인 항목은 아래에 있습니다." }),
      ],
    }),
    [question.id]: detail(question, { questions: [answeredEarlier, choice],
      comments: [comment("q-c1", question.id, 19, { authorKind: "agent", authorId: "roselin", questionId: choice.id, body: "구현 비용은 첫째가 작습니다." })] }),
    [request.id]: detail(request, { questions: [ask] }),
    [blocked.id]: detail(blocked, { nowHistory: [{ text: "모델 한도가 풀릴 때까지 기다립니다.", turn: "outside", ask: null, at: minutes(base, 60) }] }),
    [running.id]: detail(running, { nowHistory: [{ text: "화면 컴포넌트를 옮기는 중입니다.", turn: "agent", ask: null, at: minutes(base, 3) }] }),
    [verifying.id]: detail(verifying),
    [snoozed.id]: detail(snoozed, { comments: [comment("s-c1", snoozed.id, 200, { authorKind: "agent", authorId: "roselin", body: "초안을 올렸습니다. 검수 부탁드립니다." })] }),
  };
  const entry = (patch: Partial<PersistentReportEntry> & { key: string; card_id: string; card_numbers: number[]; title: string }): PersistentReportEntry => ({
    kind: "see", context: "", action: "", options: [], state: "open", answer: "", updated_at: minutes(base, 12), ...patch,
  });
  const entries: PersistentReportEntry[] = [
    entry({ key: `card_${review.id}`, card_id: review.id, card_numbers: [review.number!], title: longReview, card_status: "review", context: "검수 요청" }),
    entry({ key: `${CARD_QUESTION_KEY_PREFIX}${choice.id}`, card_id: question.id, card_numbers: [question.number!], title: "의존 관계 표시", kind: "ask", question_id: choice.id,
      question_kind: "choice", question_title: "의존 관계 표시", question_text: choice.text, options: choice.options ?? [], question_option_details: choice.optionDetails,
      question_thread: [{ id: "q-c1", question_id: choice.id, session_id: `${question.id}-session`, author_kind: "agent", body: "구현 비용은 첫째가 작습니다.", created_at: minutes(base, 19) }], updated_at: minutes(base, 19) }),
    entry({ key: `${CARD_QUESTION_KEY_PREFIX}${ask.id}`, card_id: request.id, card_numbers: [request.number!], title: "인증 코드 다시 받기", kind: "ask", question_id: ask.id,
      question_kind: "request", question_title: "인증 코드 다시 받기", question_text: ask.text, options: [], updated_at: minutes(base, 8) }),
    entry({ key: `card_${blocked.id}`, card_id: blocked.id, card_numbers: [blocked.number!], title: blocked.title, card_status: "blocked", updated_at: minutes(base, 60) }),
    entry({ key: `card_${snoozed.id}`, card_id: snoozed.id, card_numbers: [snoozed.number!], title: snoozed.title, card_status: "review", updated_at: minutes(base, 200) }),
    { key: "pas-own", kind: "see", title: "PAS 자체 보고", card_numbers: [], context: "카드와 이어지지 않은 장은 레일에 넣지 않는다.", action: "", options: [], state: "open", answer: "", updated_at: minutes(base, 5) },
  ];
  const list = [review, question, request, blocked, running, verifying, snoozed, hold(1), hold(2), hold(3)];
  return { cards, details, entries, list };
}
