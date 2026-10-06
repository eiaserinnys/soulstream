/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { CardRowView } from "./CardRow";
import { PersistentSessionTaskList, groupPersistentSessionTasks } from "./PersistentSessionTaskList";
import { reviewSession } from "./components-review-fixtures";

const membershipMock = vi.hoisted(() => vi.fn());
vi.mock("./use-card-membership", () => ({ useCardMembership: membershipMock }));

const baseCard = (id: string, status: CardRow["status"], positionKey = id, queuePositionKey: string | null = null): CardRow => ({
  id, folderId: "folder", title: `카드 ${id}`, request: "", brief: "", attachments: [], status, blockedKind: null,
  blockedDetail: null, positionKey, queuePositionKey, assigneeKind: "session", assigneeAgentId: "roselin",
  assigneeUserId: null, assigneeSessionId: "session", nodeId: "eiaserinnys", modelPreset: "codex-6-luna",
  version: 1, archived: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  membershipMock.mockReset();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("persistent session task list", () => {
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
