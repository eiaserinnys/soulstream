/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { PersistentSessionInstructions } from "./PersistentSessionInstructions";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("loads instructions, saves on Enter, cancels on Escape, removes empty edits, and adds", async () => {
  let instructions = [
    makeInstruction("one", "간결하게 답합니다.", ["T195", "T210"]),
    makeInstruction("two", "먼저 확인하고 답합니다.", []),
  ];
  const calls: Array<{ method: string; body: Record<string, unknown> | null }> = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ method, body });
    if (method === "GET") return Response.json({ instructions });
    if (method === "POST") {
      if (body?.text === "상한 시험") return Response.json({ error: "cap_reached" }, { status: 409 });
      const added = makeInstruction("three", String(body?.text), []);
      instructions = [added, ...instructions];
      return Response.json({ instruction: added }, { status: 201 });
    }
    const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
    const current = instructions.find((item) => item.id === id);
    if (!current) return Response.json({ error: "not_found" }, { status: 404 });
    const updated = body?.status === "removed"
      ? { ...current, status: "removed" as const }
      : { ...current, text: String(body?.text), updated_at: "2026-10-07T00:00:00.000Z" };
    instructions = instructions.map((item) => item.id === id ? updated : item);
    return Response.json({ instruction: updated });
  };

  await act(async () => root.render(<PersistentSessionInstructions sessionId="sample-pas" request={request} />));
  await settle();
  expect(rows()).toHaveLength(2);
  expect(rows()[0]?.textContent).toContain("T195, T210");
  expect(rows()[0]?.querySelector("time")?.dateTime).toBe("2026-10-06T11:00:00.000Z");

  clickIn(rows()[0]!, "수정");
  const edit = container.querySelector<HTMLInputElement>('input[aria-label="지속 지시 수정"]')!;
  await setInput(edit, "더 짧게 답합니다.");
  await press(edit, "Enter");
  await settle();
  expect(calls.at(-1)).toEqual({ method: "PUT", body: { text: "더 짧게 답합니다." } });
  expect(rows()[0]?.textContent).toContain("더 짧게 답합니다.");

  clickIn(rows()[1]!, "수정");
  const cancelled = container.querySelector<HTMLInputElement>('input[aria-label="지속 지시 수정"]')!;
  await setInput(cancelled, "취소할 내용");
  await press(cancelled, "Escape");
  expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(rows()[1]?.textContent).toContain("먼저 확인하고 답합니다.");

  clickIn(rows()[1]!, "수정");
  const emptyEdit = container.querySelector<HTMLInputElement>('input[aria-label="지속 지시 수정"]')!;
  await setInput(emptyEdit, "");
  clickIn(rows()[1]!, "저장");
  await settle();
  expect(calls.at(-1)).toEqual({ method: "PUT", body: { status: "removed" } });
  expect(rows()).toHaveLength(1);

  await setInput(container.querySelector<HTMLInputElement>('input[aria-label="새 지속 지시"]')!, "새로 추가한 지시");
  click("추가");
  await settle();
  expect(calls.at(-1)).toEqual({ method: "POST", body: { text: "새로 추가한 지시" } });
  expect(rows()[0]?.textContent).toContain("새로 추가한 지시");

  clickIn(rows()[0]!, "삭제");
  await settle();
  expect(calls.at(-1)).toEqual({ method: "PUT", body: { status: "removed" } });
  expect(rows()).toHaveLength(1);

  await setInput(container.querySelector<HTMLInputElement>('input[aria-label="새 지속 지시"]')!, "상한 시험");
  click("추가");
  await settle();
  expect(container.textContent).toContain("지속 지시 상한에 도달했습니다.");
  expect(rows()).toHaveLength(1);
});

it("shows one empty state and retries a failed instruction read", async () => {
  let attempts = 0;
  const request: typeof fetch = async () => {
    attempts += 1;
    if (attempts === 1) return Response.json({ error: { message: "일시적인 조회 실패" } }, { status: 503 });
    return Response.json({ instructions: [] });
  };

  await act(async () => root.render(<PersistentSessionInstructions sessionId="sample-pas" request={request} />));
  await settle();
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(container.textContent).toContain("조회 실패: 일시적인 조회 실패");
  click("다시 시도");
  await settle();
  expect(attempts).toBe(2);
  expect(container.textContent?.match(/지속 지시 없음/g)).toHaveLength(1);
});

function makeInstruction(id: string, text: string, source_turns: string[]) {
  return {
    id,
    text,
    source_turns,
    created_at: "2026-10-06T10:00:00.000Z",
    updated_at: "2026-10-06T11:00:00.000Z",
    origin: "user" as const,
  };
}

function rows() {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="persistent-instruction-row"]')];
}

function click(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  act(() => button.click());
}

function clickIn(element: HTMLElement, label: string) {
  const button = [...element.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  if (!button) throw new Error(`Button not found in row: ${label}`);
  act(() => button.click());
}

async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(input: HTMLInputElement, key: string) {
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
