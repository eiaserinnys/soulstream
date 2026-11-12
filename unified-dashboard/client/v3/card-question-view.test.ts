import { describe, expect, it } from "vitest";
import type { CardComment, CardQuestion } from "@seosoyoung/soul-ui/cards/card-types";
import type { PersistentReportEntry } from "@seosoyoung/soul-ui";
import { cardQuestionDetailView, cardQuestionSheetView } from "./CardQuestionBlock";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 12, 5, minute)).toISOString();

const question: CardQuestion = {
  id: "q-secret", title: "에이전트 접속 비밀값을 숨길까요?",
  text: "에이전트 세션을 띄울 때마다 도구 접속 비밀값 9개가 실행 명령에 그대로 적힙니다.",
  options: ["파일로 옮기기", "서버 설정으로 가리기", "그대로 두기"],
  kind: "choice",
  optionDetails: [
    { label: "파일로 옮기기", description: "비밀값을 저만 여는 파일에 두고 명령에는 파일 위치만 적습니다.", recommended: true },
    { label: "서버 설정으로 가리기", description: "다른 계정이 남의 실행 명령을 못 보게 합니다." },
    { label: "그대로 두기" },
  ],
  attachments: [
    { type: "image", url: "/evidence.png", previewUrl: "/evidence-preview.png", label: "지금 실행 명령에 보이는 모습" },
    { type: "link", url: "/report", label: "점검 기록" },
  ],
  answer: null, askedAt: at(10), answeredAt: null, selectedOption: null, revision: 2, revisedAt: at(18),
};

const comment = (id: string, createdAt: string, authorKind: "user" | "agent", body: string, questionId?: string): CardComment => ({
  id, cardId: "card-1", authorKind, authorId: authorKind === "user" ? "sample" : "roselin",
  sessionId: null, kind: "comment", body, createdAt, ...(questionId === undefined ? {} : { questionId }),
});

const comments: CardComment[] = [
  comment("t2", at(16), "agent", "지금은 비밀값이 실행 명령 안에 들어 있습니다.", "q-secret"),
  comment("c1", at(9), "user", "일반 커멘트"),
  comment("t1", at(12), "user", "파일로 옮기면 어떻게 해결 돼?", "q-secret"),
  comment("t3", at(20), "user", "이전부터 있던 문제지?", "q-secret"),
  { ...comment("note-1", at(21), "agent", "질문에 묶인 노트", "q-secret"), kind: "note" },
];

const entry: PersistentReportEntry & { card_id: string; card_status: string } = {
  key: "cq_q-secret", kind: "ask", title: "에이전트 접속 비밀값을 숨길까요?", card_numbers: [1132],
  context: "에이전트 세션을 띄울 때마다 도구 접속 비밀값 9개가 실행 명령에 그대로 적힙니다.",
  action: "", options: [], state: "open", answer: "", updated_at: "2026-11-12T05:20:00.000Z",
  card_id: "card-1", card_status: "blocked", question_id: "q-secret",
  question_title: "에이전트 접속 비밀값을 숨길까요?", question_text: "실행 명령에 비밀값 9개가 그대로 적힙니다.",
  question_kind: "choice",
  question_option_details: [
    { label: "파일로 옮기기", description: "파일 위치만 남깁니다.", recommended: true },
    { label: "그대로 두기" },
  ],
  question_attachments: question.attachments,
  question_thread: [
    { id: "t2", question_id: "q-secret", author_kind: "agent", body: "지금은 명령 안에 들어 있습니다.", created_at: at(16), session_id: null },
    { id: "t1", question_id: "q-secret", author_kind: "user", body: "어떻게 해결 돼?", created_at: at(12), session_id: null },
  ],
  question_revision: 2, question_revised_at: at(18),
};

describe("cardQuestionDetailView", () => {
  it("maps a new choice question with its descriptions, recommendation, attachments and ordered thread", () => {
    const view = cardQuestionDetailView(question, comments, "카드 제목");
    expect(view).toEqual({
      id: "q-secret",
      title: "에이전트 접속 비밀값을 숨길까요?",
      background: question.text,
      kind: "choice",
      options: [
        { label: "파일로 옮기기", description: "비밀값을 저만 여는 파일에 두고 명령에는 파일 위치만 적습니다.", recommended: true },
        { label: "서버 설정으로 가리기", description: "다른 계정이 남의 실행 명령을 못 보게 합니다.", recommended: false },
        { label: "그대로 두기", description: null, recommended: false },
      ],
      attachments: question.attachments,
      thread: [
        { id: "t1", author: "user", body: "파일로 옮기면 어떻게 해결 돼?", at: at(12) },
        { id: "t2", author: "agent", body: "지금은 비밀값이 실행 명령 안에 들어 있습니다.", at: at(16) },
        { id: "t3", author: "user", body: "이전부터 있던 문제지?", at: at(20) },
      ],
      open: true,
      selectedOption: null,
      answer: null,
      revisedAt: at(18),
      awaitingAgent: true,
    });
  });

  it("keeps an old question's full text and name-only choices without a title line or 권함", () => {
    const legacy: CardQuestion = {
      id: "q-legacy",
      text: "claude CLI 인자에 MCP 인증 헤더가 통째로 실려 같은 서버의 다른 계정이 읽을 수 있습니다(외부 노출은 확인 안 됨). 설정을 0600 파일로 넘기게 고치는 후속 카드를 만들까요?",
      options: ["후속 카드 생성", "hidepid로 막기", "그대로 둔다"], answer: null, askedAt: at(5), answeredAt: null,
    };
    const view = cardQuestionDetailView(legacy, [], "카드 제목");
    expect(view.title).toBeNull();
    expect(view.background).toBe(legacy.text);
    expect(view.kind).toBe("choice");
    expect(view.options).toEqual([
      { label: "후속 카드 생성", description: null, recommended: false },
      { label: "hidepid로 막기", description: null, recommended: false },
      { label: "그대로 둔다", description: null, recommended: false },
    ]);
    expect(view.attachments).toEqual([]);
    expect(view.thread).toEqual([]);
    expect(view.revisedAt).toBeNull();
    expect(view.selectedOption).toBeNull();
  });

  it("marks a revised question only when revision is two or more", () => {
    expect(cardQuestionDetailView({ ...question, revision: 1, revisedAt: at(18) }, [], "").revisedAt).toBeNull();
    expect(cardQuestionDetailView({ ...question, revision: undefined, revisedAt: at(18) }, [], "").revisedAt).toBeNull();
    expect(cardQuestionDetailView({ ...question, revision: 2, revisedAt: null }, [], "").revisedAt).toBeNull();
    expect(cardQuestionDetailView({ ...question, revision: 3, revisedAt: at(18) }, [], "").revisedAt).toBe(at(18));
  });

  it("closes the question on an answer and keeps a text answer's selected option empty", () => {
    const view = cardQuestionDetailView({ ...question, answer: "파일로 옮기기만 빼고 진행", answeredAt: at(22), selectedOption: null }, comments, "");
    expect(view.open).toBe(false);
    expect(view.answer).toBe("파일로 옮기기만 빼고 진행");
    expect(view.selectedOption).toBeNull();
    expect(view.awaitingAgent).toBe(false);
    const chosen = cardQuestionDetailView({ ...question, answer: "파일로 옮기기", answeredAt: at(22), selectedOption: "파일로 옮기기" }, comments, "");
    expect(chosen.selectedOption).toBe("파일로 옮기기");
  });

  it("waits only while the open thread's last turn is the user's", () => {
    const agentLast: CardComment[] = [comment("t1", at(12), "user", "되묻기", "q-secret"), comment("t2", at(16), "agent", "답", "q-secret")];
    expect(cardQuestionDetailView(question, agentLast, "").awaitingAgent).toBe(false);
    expect(cardQuestionDetailView({ ...question, answer: "그대로 두기", answeredAt: at(22) }, comments, "").awaitingAgent).toBe(false);
  });

  it("keeps the request kind and its 했어 choice for the action row", () => {
    const request: CardQuestion = {
      id: "q-request", kind: "request", title: "아이폰 앱을 업데이트해 주십시오",
      text: "질문 장이 바뀐 판이 TestFlight에 올라왔습니다.", options: ["했어"], answer: null, askedAt: at(30), answeredAt: null,
    };
    const view = cardQuestionDetailView(request, [], "");
    expect(view.kind).toBe("request");
    expect(view.options).toEqual([{ label: "했어", description: null, recommended: false }]);
  });
});

describe("cardQuestionSheetView", () => {
  it("reads the server-projected question fields and thread in time order", () => {
    const view = cardQuestionSheetView(entry);
    expect(view).toEqual({
      id: "q-secret",
      title: "에이전트 접속 비밀값을 숨길까요?",
      background: "실행 명령에 비밀값 9개가 그대로 적힙니다.",
      kind: "choice",
      options: [
        { label: "파일로 옮기기", description: "파일 위치만 남깁니다.", recommended: true },
        { label: "그대로 두기", description: null, recommended: false },
      ],
      attachments: question.attachments,
      thread: [
        { id: "t1", author: "user", body: "어떻게 해결 돼?", at: at(12) },
        { id: "t2", author: "agent", body: "지금은 명령 안에 들어 있습니다.", at: at(16) },
      ],
      open: true,
      selectedOption: null,
      answer: null,
      revisedAt: at(18),
      awaitingAgent: false,
    });
    // 마지막 글이 사용자 글이면 담당의 답을 기다린다.
    expect(cardQuestionSheetView({ ...entry, question_thread: [entry.question_thread![1]!] }).awaitingAgent).toBe(true);
  });

  it("falls back to the legacy sheet fields when question detail fields are absent", () => {
    const legacy: PersistentReportEntry = {
      key: "cq_legacy", kind: "ask", title: "입력 위치 확인", card_numbers: [531],
      context: "추가 커멘트를 장 안에서 바로 쓸까요?", action: "", options: ["장 안에서", "카드에서"],
      state: "open", answer: "", updated_at: "preview",
    };
    const view = cardQuestionSheetView(legacy);
    expect(view.title).toBe("입력 위치 확인");
    expect(view.background).toBe("추가 커멘트를 장 안에서 바로 쓸까요?");
    expect(view.kind).toBe("choice");
    expect(view.options).toEqual([
      { label: "장 안에서", description: null, recommended: false },
      { label: "카드에서", description: null, recommended: false },
    ]);
    expect(view.attachments).toEqual([]);
    expect(view.thread).toEqual([]);
    expect(view.revisedAt).toBeNull();
    expect(view.open).toBe(true);
  });

  it("shows the received answer and the revised time only from revision two", () => {
    const answered = { ...entry, state: "answered" as const, answer: "파일로 옮기기" };
    const view = cardQuestionSheetView(answered);
    expect(view.open).toBe(false);
    expect(view.answer).toBe("파일로 옮기기");
    expect(view.selectedOption).toBe("파일로 옮기기");
    expect(cardQuestionSheetView({ ...entry, question_revision: 1 }).revisedAt).toBeNull();
    expect(cardQuestionSheetView({ ...entry, question_revision: undefined }).revisedAt).toBeNull();
    expect(cardQuestionSheetView({ ...entry, question_kind: "request", question_revision: 2 }).kind).toBe("request");
  });
});
