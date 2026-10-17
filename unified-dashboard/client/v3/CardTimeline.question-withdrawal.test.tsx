/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { CardDetail, CardQuestion, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { CardTimeline } from "./CardTimeline";

const card = {
  id: "card-1", folderId: "folder-1", title: "질문 철회", request: "요청", brief: "", attachments: [], status: "blocked",
  blockedKind: "question", blockedDetail: null, positionKey: "a", queuePositionKey: null,
  assigneeKind: "session", assigneeAgentId: "roselin", assigneeUserId: null, assigneeSessionId: "session-1",
  nodeId: "eiaserinnys", modelPreset: "codex-6-luna", version: 1, archived: false,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
} as unknown as CardRow;

function question(id: string, askedAt: string, options: string[] | null): CardQuestion {
  return { id, text: `질문 ${id}`, options, answer: null, askedAt, answeredAt: null };
}

function cardDetail(questions: CardQuestion[]): CardDetail {
  return { card, reports: [], questions, sessions: [] };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

it("shows a withdrawn question and reason without answer buttons while an open question stays answerable", async () => {
  const reason = "커멘트에서 B안으로 정해져 거둡니다";
  const withdrawn = {
    ...question("withdrawn", "2026-10-01T01:00:00Z", ["A안", "B안"]),
    withdrawnAt: "2026-10-01T02:00:00Z",
    withdrawalReason: reason,
  } as CardQuestion;
  const open = question("open", "2026-10-01T03:00:00Z", ["계속"]);
  await act(() => root.render(<CardTimeline card={card} detail={cardDetail([withdrawn, open])} portraitUrl={null} pending={false} onAnswer={() => {}} />));

  const entries = [...container.querySelectorAll<HTMLElement>('[data-card-entry="질문"]')];
  expect(entries).toHaveLength(2);
  expect(entries[0]!.textContent).toContain("질문 withdrawn");
  expect(entries[0]!.querySelector(".v3-card-bubble-kind")?.textContent).toContain("철회됨");
  expect(entries[0]!.querySelector(".v3-card-question-withdrawal")?.textContent).toBe(reason);
  expect(entries[0]!.querySelector(".v3-card-answer-options")).toBeNull();
  expect(entries[1]!.querySelector(".v3-card-bubble-kind")?.textContent).not.toContain("철회됨");
  expect(entries[1]!.querySelectorAll(".v3-card-answer-options button")).toHaveLength(1);
});

it("omits the withdrawal reason line when the reason is empty", async () => {
  const withdrawn = {
    ...question("withdrawn", "2026-10-01T01:00:00Z", ["A안"]),
    withdrawnAt: "2026-10-01T02:00:00Z",
    withdrawalReason: "",
  } as CardQuestion;
  await act(() => root.render(<CardTimeline card={card} detail={cardDetail([withdrawn])} portraitUrl={null} pending={false} onAnswer={() => {}} />));

  const entry = container.querySelector<HTMLElement>('[data-card-entry="질문"]')!;
  expect(entry.querySelector(".v3-card-bubble-kind")?.textContent).toContain("철회됨");
  expect(entry.querySelector(".v3-card-question-withdrawal")).toBeNull();
  expect(entry.querySelector(".v3-card-answer-options")).toBeNull();
});
