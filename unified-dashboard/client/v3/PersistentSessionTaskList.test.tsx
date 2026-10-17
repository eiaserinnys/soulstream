/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardDetail, CardQuestion, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { CardRowView } from "./CardRow";
import { PersistentSessionTaskList, groupPersistentSessionTasks, isQuestionTooltipCard, latestUnansweredTooltipQuestion, persistentTaskTooltipContent } from "./PersistentSessionTaskList";
import { reviewSession } from "./components-review-fixtures";

const membershipMock = vi.hoisted(() => vi.fn());
vi.mock("./use-card-membership", () => ({ useCardMembership: membershipMock }));

const baseCard = (id: string, status: CardRow["status"], positionKey = id, queuePositionKey: string | null = null): CardRow => ({
  id, folderId: "folder", title: `카드 ${id}`, request: "", brief: "", attachments: [], status, blockedKind: null,
  blockedDetail: null, positionKey, queuePositionKey, assigneeKind: "session", assigneeAgentId: "roselin",
  assigneeUserId: null, assigneeSessionId: "session", nodeId: "eiaserinnys", modelPreset: "codex-6-luna",
  version: 1, archived: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
});
const originalStoreActions = { loadCard: useCardStore.getState().loadCard, mutate: useCardStore.getState().mutate };

function enableTaskTooltips() {
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: media.includes("min-width: 768px"), media, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

function question(id: string, askedAt: string, options: string[] | null, answer: string | null = null): CardQuestion {
  return { id, text: `질문 ${id}`, options, answer, askedAt, answeredAt: answer === null ? null : askedAt };
}

function cardDetail(card: CardRow, questions: CardQuestion[] = []): CardDetail {
  return { card, reports: [], questions, sessions: [] };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  membershipMock.mockReset();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  useCardStore.setState({ byId: {}, details: {}, errors: {}, loadCard: originalStoreActions.loadCard, mutate: originalStoreActions.mutate });
});

describe("persistent session task list", () => {
  it("identifies blocked question cards for an isolated tooltip provider", () => {
    expect(isQuestionTooltipCard({ ...baseCard("question", "blocked"), blockedKind: "question" })).toBe(true);
    expect(isQuestionTooltipCard({ ...baseCard("blocked", "blocked"), blockedKind: "limit" })).toBe(false);
    expect(isQuestionTooltipCard({ ...baseCard("running", "running"), blockedKind: "question" })).toBe(false);
  });

  it("includes only the truncated title and non-empty current status fields in tooltip content", () => {
    const card = {
      ...baseCard("tooltip", "running"),
      title: "PAS 카드 목록 호버 툴팁",
      now: { text: "현재 진행", turn: "user" as const, ask: "확인 요청", updatedAt: "2026-10-14T00:00:00Z", sessionId: "session" },
    };

    expect(persistentTaskTooltipContent(card, true)).toEqual({
      title: "PAS 카드 목록 호버 툴팁", now: "현재 진행", ask: "확인 요청",
    });
    expect(persistentTaskTooltipContent(card, false)).toEqual({ now: "현재 진행", ask: "확인 요청" });
    expect(persistentTaskTooltipContent({ ...card, now: { ...card.now, turn: "agent" } }, false))
      .toEqual({ now: "현재 진행" });
    expect(persistentTaskTooltipContent({ ...card, now: { ...card.now, text: "", ask: "   " } }, false)).toBeNull();
    expect(persistentTaskTooltipContent({ ...card, now: { ...card.now, text: "", ask: "다음 확인" } }, false))
      .toEqual({ ask: "다음 확인" });
    expect(persistentTaskTooltipContent({ ...card, now: null }, false, question("selected", "2026-10-14T10:00:00Z", ["계속"])))
      .toEqual({ ask: "질문 selected" });
  });

  it("selects only the latest unanswered question and exposes options only for that question", () => {
    const detail = cardDetail(baseCard("question-choice", "blocked"), [
      question("older-open", "2026-10-13T10:00:00Z", ["이전 선택지"]),
      question("answered-latest", "2026-10-14T10:00:00Z", ["이미 답한 선택지"], "완료"),
      question("latest-open", "2026-10-14T09:00:00Z", ["계속", "보류"]),
    ]);
    expect(latestUnansweredTooltipQuestion(detail)).toEqual(detail.questions[2]);
    expect(persistentTaskTooltipContent({ ...detail.card, now: { text: "진행", turn: "user", ask: "질문 latest-open", updatedAt: "2026-10-14T10:00:00Z", sessionId: "session" } }, false, detail.questions[2])?.ask)
      .toBe("질문 latest-open");
    const twoOpen = cardDetail(detail.card, [
      question("older-open", "2026-10-13T10:00:00Z", ["이전 선택지"]),
      question("latest-open", "2026-10-14T10:00:00Z", ["계속", "보류"]),
    ]);
    const afterLatestAnswer = cardDetail(detail.card, [twoOpen.questions[0]!, question("latest-open", "2026-10-14T10:00:00Z", ["계속", "보류"], "완료")]);
    const nextQuestion = latestUnansweredTooltipQuestion(afterLatestAnswer)!;
    expect(nextQuestion.id).toBe("older-open");
    expect(persistentTaskTooltipContent({ ...detail.card, now: { text: "진행", turn: "user", ask: "질문 latest-open", updatedAt: "2026-10-14T10:00:00Z", sessionId: "session" } }, false, nextQuestion)?.ask)
      .toBe("질문 older-open");
    expect(latestUnansweredTooltipQuestion(cardDetail(detail.card, [question("free", "2026-10-14T10:00:00Z", null)]))?.options).toBeNull();
    expect(latestUnansweredTooltipQuestion(cardDetail(detail.card, [question("done", "2026-10-14T10:00:00Z", ["답"], "완료")]))).toBeNull();
  });

  it("skips withdrawn unanswered questions in the PAS task tooltip", () => {
    const card = baseCard("withdrawn-question", "blocked");
    const open = question("open", "2026-10-14T09:00:00Z", ["계속"]);
    const withdrawn = {
      ...question("withdrawn", "2026-10-14T10:00:00Z", ["A안", "B안"]),
      withdrawnAt: "2026-10-14T11:00:00Z",
      withdrawalReason: "커멘트에서 결정됐습니다",
    } as CardQuestion;

    expect(latestUnansweredTooltipQuestion(cardDetail(card, [open, withdrawn]))).toEqual(open);
  });

  it("loads blocked question detail on row focus only when cached details are missing or stale", async () => {
    enableTaskTooltips();
    const card = { ...baseCard("question-load", "blocked"), blockedKind: "question" as const,
      now: { text: "선택을 기다립니다", turn: "user" as const, ask: "계속할까요?", updatedAt: "2026-10-14T10:00:00Z", sessionId: "session" } };
    const detail = cardDetail(card, [question("q1", "2026-10-14T10:00:00Z", ["계속"])]);
    const loadCard = vi.fn(async () => {
      useCardStore.setState({ byId: { [card.id]: card }, details: { [card.id]: detail } });
      return detail;
    });
    useCardStore.setState({ byId: { [card.id]: card }, details: {}, loadCard });
    await act(() => root.render(<PersistentSessionTaskList cards={[card]} onOpenCard={() => {}}/>));
    await act(() => container.querySelector<HTMLButtonElement>(".v3-card-summary-row")!.focus());
    expect(loadCard).toHaveBeenCalledOnce();
    expect(loadCard).toHaveBeenCalledWith(card.id);

    await act(() => root.unmount());
    root = createRoot(container);
    loadCard.mockClear();
    useCardStore.setState({ byId: { [card.id]: card }, details: { [card.id]: detail } });
    await act(() => root.render(<PersistentSessionTaskList cards={[card]} onOpenCard={() => {}}/>));
    await act(() => container.querySelector<HTMLButtonElement>(".v3-card-summary-row")!.focus());
    expect(loadCard).not.toHaveBeenCalled();

    await act(() => root.unmount());
    root = createRoot(container);
    const staleDetail = cardDetail({ ...card, version: card.version - 1 }, [question("stale", "2026-10-14T10:00:00Z", ["오래된 선택지"])]);
    let resolveLoad!: (loaded: CardDetail) => void;
    const pendingLoad = new Promise<CardDetail>(resolve => { resolveLoad = resolve; });
    loadCard.mockReturnValue(pendingLoad);
    useCardStore.setState({ byId: { [card.id]: card }, details: { [card.id]: staleDetail } });
    await act(() => root.render(<PersistentSessionTaskList cards={[card]} onOpenCard={() => {}}/>));
    await act(() => container.querySelector<HTMLButtonElement>(".v3-card-summary-row")!.focus());
    expect(loadCard).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[data-tooltip-field="ask"]')?.textContent).toBe("계속할까요?");
    expect(document.body.querySelector(".pas-report-actions")).toBeNull();
    await act(async () => {
      useCardStore.setState({ byId: { [card.id]: card }, details: { [card.id]: detail } });
      resolveLoad(detail);
      await pendingLoad;
    });
    expect(document.body.querySelector('[data-tooltip-field="ask"]')?.textContent).toBe("질문 q1");
    expect(document.body.querySelector(".pas-report-actions")?.textContent).toBe("계속");
  });

  it("opens a tooltip from question text and options when the blocked card has no now", async () => {
    enableTaskTooltips();
    const card = { ...baseCard("question-no-now", "blocked"), title: "짧은 제목", blockedKind: "question" as const, now: null };
    const detail = cardDetail(card, [question("q1", "2026-10-14T10:00:00Z", ["계속"])]);
    useCardStore.setState({ byId: { [card.id]: card }, details: { [card.id]: detail } });
    await act(() => root.render(<PersistentSessionTaskList cards={[card]} onOpenCard={() => {}}/>));
    await act(() => container.querySelector<HTMLButtonElement>(".v3-card-summary-row")!.focus());

    expect(document.body.querySelector('[data-tooltip-field="ask"]')?.textContent).toBe("질문 q1");
    expect([...document.body.querySelectorAll<HTMLButtonElement>("button")].some(button => button.textContent === "계속")).toBe(true);
  });

  it("keeps the tooltip open while sending, shows failure in place, and closes after a successful answer", async () => {
    enableTaskTooltips();
    const card = { ...baseCard("question-answer", "blocked"), blockedKind: "question" as const,
      now: { text: "선택을 기다립니다", turn: "user" as const, ask: "계속할까요?", updatedAt: "2026-10-14T10:00:00Z", sessionId: "session" } };
    const detail = cardDetail(card, [question("q/1", "2026-10-14T10:00:00Z", ["계속", "멈춤"])]);
    let rejectPending!: (error: Error) => void;
    const pendingMutation = new Promise<CardDetail>((_resolve, reject) => { rejectPending = reject; });
    const mutate = vi.fn().mockReturnValueOnce(pendingMutation).mockResolvedValueOnce(detail);
    useCardStore.setState({ byId: { [card.id]: card }, details: { [card.id]: detail }, mutate });
    await act(() => root.render(<PersistentSessionTaskList cards={[card]} onOpenCard={() => {}}/>));
    await act(() => container.querySelector<HTMLButtonElement>(".v3-card-summary-row")!.focus());

    const option = () => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "계속")!;
    expect(option()).toBeDefined();
    await act(async () => { option().click(); await Promise.resolve(); });
    expect(mutate).toHaveBeenCalledWith(card.id, "/questions/q%2F1/answer", { answer: "계속" });
    expect(option().disabled).toBe(true);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(document.body.querySelector(".v3-persistent-task-tooltip .v3-surface")).not.toBeNull();
    expect(option().disabled).toBe(true);

    await act(async () => { rejectPending(new Error("network error")); await pendingMutation.catch(() => undefined); });
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe("답을 보내지 못했습니다");
    expect(option().disabled).toBe(false);

    await act(async () => { option().click(); await Promise.resolve(); });
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.querySelector(".v3-persistent-task-tooltip .v3-surface")).toBeNull();
  });

  it("groups the complete card status inventory in the approved order and omits completed states", () => {
    const cards = [
      baseCard("done", "done"), baseCard("todo", "todo"), baseCard("queued", "queued"),
      baseCard("review", "review"), baseCard("cancelled", "cancelled"), baseCard("blocked", "blocked"),
      baseCard("running", "running"),
    ];

    expect(groupPersistentSessionTasks(cards).map(group => group.status)).toEqual([
      "running", "blocked", "review", "queued", "todo",
    ]);
    expect(groupPersistentSessionTasks(cards).flatMap(group => group.cards.map(card => card.id)))
      .not.toContain("done");
    expect(groupPersistentSessionTasks(cards).flatMap(group => group.cards.map(card => card.id)))
      .not.toContain("cancelled");
  });

  it("sorts queued cards by queue position and other groups by position", () => {
    const cards = [
      baseCard("running-z", "running", "z"), baseCard("running-a", "running", "a"),
      baseCard("queued-z", "queued", "a", "z"), baseCard("queued-a", "queued", "z", "a"),
    ];
    const groups = groupPersistentSessionTasks(cards);

    expect(groups.find(group => group.status === "running")?.cards.map(card => card.id))
      .toEqual(["running-a", "running-z"]);
    expect(groups.find(group => group.status === "queued")?.cards.map(card => card.id))
      .toEqual(["queued-a", "queued-z"]);
  });

  it("renders supplied fixture cards without mounting the live membership hook", () => {
    const cards = [baseCard("one", "running"), baseCard("two", "blocked"), baseCard("three", "todo")];
    act(() => root.render(<PersistentSessionTaskList cards={cards} onOpenCard={() => {}}/>));

    expect(container.querySelectorAll("[data-task-status-group]")).toHaveLength(3);
    expect(container.textContent).toContain("실행 중");
    expect(container.textContent).toContain("막힘");
    expect(container.textContent).toContain("드래프트");
    expect(membershipMock).not.toHaveBeenCalled();
  });

  it("starts with only drafts collapsed and persists group toggles", async () => {
    localStorage.clear();
    const cards = [baseCard("running", "running"), baseCard("draft", "todo")];
    membershipMock.mockReturnValue({ cards, loading: false, error: null, retry: vi.fn() });
    await act(() => root.render(<PersistentSessionTaskList onOpenCard={() => {}}/>));

    const draftGroup = container.querySelector<HTMLElement>('[data-task-status-group="todo"]')!;
    const draftToggle = draftGroup.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    const draftName = draftToggle.querySelector<HTMLElement>(".v3-persistent-task-group-name")!;
    const draftCount = draftToggle.querySelector<HTMLElement>(".v3-persistent-task-group-count")!;
    expect(draftToggle.getAttribute("aria-expanded")).toBe("false");
    expect(draftName.textContent).toBe("드래프트");
    expect(draftName.nextElementSibling).toBe(draftCount);
    expect(draftCount.textContent).toBe("1개");
    expect(draftCount.nextElementSibling?.tagName.toLowerCase()).toBe("svg");
    expect(draftGroup.querySelector(".v3-run-list")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-task-status-group="running"] button[aria-expanded]')?.getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem("soulstream:pas-task-groups:v1")).toBe(JSON.stringify({ collapsed: ["todo"] }));

    await act(() => draftToggle.click());
    expect(container.querySelector('[data-task-status-group="todo"] .v3-run-list')).not.toBeNull();
    expect(container.querySelector('[data-task-status-group="todo"] .v3-persistent-task-group-count')?.textContent).toBe("1개");
    expect(JSON.parse(localStorage.getItem("soulstream:pas-task-groups:v1")!)).toEqual({ collapsed: [] });

    await act(() => root.unmount());
    root = createRoot(container);
    await act(() => root.render(<PersistentSessionTaskList cards={cards} onOpenCard={() => {}}/>));
    expect(container.querySelector<HTMLButtonElement>('[data-task-status-group="todo"] button[aria-expanded]')?.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders the summary row with only its optional number, one-line title, and assignee portrait", async () => {
    const open = vi.fn();
    const card = { ...baseCard("summary", "running"), number: 42, title: "긴 카드 제목" };
    await act(() => root.render(<CardRowView variant="summary" card={card} onOpen={open}
      assignee={reviewSession} summaryNumberTemplate="#1024"/>));

    const row = container.querySelector<HTMLButtonElement>("button.v3-card-summary-row")!;
    expect(row).not.toBeNull();
    expect(row.getAttribute("aria-label")).toContain("긴 카드 제목");
    expect(row.querySelector("img")?.getAttribute("src")).toBe(reviewSession.agentPortraitUrl);
    expect(row.textContent).toContain("#42");
    expect(row.textContent).toContain("긴 카드 제목");
    expect(row.textContent).not.toContain("실행 중");
    expect(row.querySelector(".v3-card-summary-number-slot")?.textContent).toContain("#1024");
    expect(row.querySelector(".v3-card-summary-number-reserve")?.getAttribute("aria-hidden")).toBe("true");
    expect(row.querySelector(".v3-card-summary-number")?.textContent).toBe("#42");
    expect(row.querySelector(".v3-card-summary-title")?.textContent).toBe("긴 카드 제목");
    expect(row.querySelector(".v3-card-summary-title")?.getAttribute("title")).toBeNull();
    expect(row.querySelector(".v3-card-summary-avatar")).not.toBeNull();
    expect(container.querySelector(".v3-run-row")).toBeNull();
    await act(() => row.click());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("omits the number for legacy cards without one", async () => {
    await act(() => root.render(<CardRowView variant="summary" card={{...baseCard("old", "todo"), assigneeAgentId:null,
      assigneeSessionId:null, assigneeKind:null}} onOpen={() => {}}/>));
    const row = container.querySelector("button.v3-card-summary-row")!;
    expect(row.textContent).toContain("카드 old");
    expect(row.textContent).not.toContain("#");
    expect(row.querySelector(".v3-card-summary-number-slot")).toBeNull();
    expect(row.querySelector(".v3-card-summary-avatar")).toBeNull();
  });

  it("reserves the widest numbered card column for every row in the list", () => {
    const cards = [
      {...baseCard("one", "running"), number:7},
      {...baseCard("two", "running"), number:98},
      {...baseCard("three", "running"), number:412},
      {...baseCard("four", "running"), number:1024},
    ];
    act(() => root.render(<PersistentSessionTaskList cards={cards} onOpenCard={() => {}}/>));

    const slots = [...container.querySelectorAll(".v3-card-summary-number-reserve")];
    expect(slots).toHaveLength(4);
    expect(slots.map(slot => slot.textContent)).toEqual(["#1024", "#1024", "#1024", "#1024"]);
    expect(slots.every(slot => slot.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("keeps the number reservation across collapsed groups", () => {
    localStorage.setItem("soulstream:pas-task-groups:v1", JSON.stringify({ collapsed: ["todo"] }));
    const cards = [{ ...baseCard("visible", "running"), number: 7 }, { ...baseCard("draft", "todo"), number: 1024 }];
    act(() => root.render(<PersistentSessionTaskList cards={cards} onOpenCard={() => {}}/>));

    expect(container.querySelector('[data-task-status-group="todo"] .v3-run-list')).toBeNull();
    expect(container.querySelector('[data-task-status-group="running"] .v3-card-summary-number-reserve')?.textContent).toBe("#1024");
  });

  it("offers a retry for membership errors and replaces the error with the refreshed list", async () => {
    const retry = vi.fn();
    membershipMock.mockReturnValue({cards:[],loading:true,error:"request failed",retry});
    await act(() => root.render(<PersistentSessionTaskList onOpenCard={() => {}}/>));

    const list = container.querySelector<HTMLElement>("[data-testid='persistent-session-task-list']")!;
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "다시 시도");
    expect(list.getAttribute("aria-busy")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("작업 목록을 불러오지 못했습니다.");
    expect(button).not.toBeNull();
    await act(() => button!.click());
    expect(retry).toHaveBeenCalledTimes(1);

    membershipMock.mockReturnValue({cards:[baseCard("ready", "running")],loading:false,error:null,retry});
    await act(() => root.render(<PersistentSessionTaskList onOpenCard={() => {}}/>));
    expect(container.textContent).toContain("카드 ready");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
