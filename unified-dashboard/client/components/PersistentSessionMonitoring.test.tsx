/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { PersistentSessionMonitoring } from "./PersistentSessionMonitoring";
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

it("pairs failed turns by event id and deduplicates overlapping pages despite timestamp order", async () => {
  const calls: string[] = [];
  const request: typeof fetch = vi.fn(async (input) => {
    const url = new URL(String(input), "https://sample.invalid");
    calls.push(`${url.pathname}${url.search}`);
    if (url.searchParams.has("before")) return Response.json({
      messages: [
        { id: 3, event_type: "complete", payload: { usage: { input_tokens: 100, output_tokens: 50 }, turn_cost_usd: 0.42 }, created_at: "2026-10-06T02:01:00.000Z" },
        { id: 0, event_type: "generation_started", payload: { generation: 1 }, created_at: "2026-10-06T02:12:00.000Z" },
      ],
      next_cursor: null,
    });
    if (url.searchParams.get("event_types") === "generation_started") {
      return Response.json({ messages: [{ id: 4, event_type: "generation_started", payload: { generation: 7 }, created_at: "2026-10-06T02:00:00.000Z" }], next_cursor: null });
    }
    return Response.json({
      messages: [
        { id: 5, event_type: "context_usage", payload: { used_tokens: 912, max_tokens: 1000, percent: 91.2, estimated: false }, created_at: "2026-10-06T02:11:00.000Z" },
        { id: 7, event_type: "user_message", payload: {}, created_at: "2026-10-06T02:10:00.000Z" },
        { id: 6, event_type: "error", payload: {}, created_at: "2026-10-06T02:09:00.000Z" },
        { id: 8, event_type: "complete", payload: { usage: { input_tokens: 100, output_tokens: 50 }, turn_cost_usd: 0.62 }, created_at: "2026-10-06T02:08:00.000Z" },
        { id: 4, event_type: "generation_started", payload: { generation: 7, reason: "weekly_headroom", current: { model: "gpt-6.1-sol-preview-2026-09-30-long" } }, created_at: "2026-10-06T02:07:00.000Z" },
        { id: 3, event_type: "complete", payload: { usage: { input_tokens: 100, output_tokens: 50 }, turn_cost_usd: 0.42 }, created_at: "2026-10-06T02:06:00.000Z" },
        { id: 2, event_type: "context_usage", payload: { used_tokens: 220, max_tokens: 1000, percent: 22, estimated: false }, created_at: "2026-10-06T02:05:00.000Z" },
        { id: 1, event_type: "generation_started", payload: { generation: 6 }, created_at: "2026-10-06T02:04:00.000Z" },
      ],
      next_cursor: "older-than-page",
    });
  });

  await act(async () => root.render(<PersistentSessionMonitoring sessionId="sample-pas" nodeId="sample-node" request={request} />));
  await settle();

  expect(calls).toContain("/api/sessions/sample-pas/timeline?event_types=generation_started&limit=1");
  expect(calls).toContain("/api/sessions/sample-pas/timeline?event_types=generation_started%2Ccomplete%2Ccontext_usage%2Cerror%2Cuser_message%2Cintervention_sent&limit=100");
  expect(container.textContent).toContain("세대 7");
  expect(container.textContent).toContain("컨텍스트 22.0% · 정가 $0.42");
  expect(container.textContent).toContain("정가 $0.62");
  expect(container.textContent).not.toContain("91.2%");
  expect(container.textContent).not.toContain("컨텍스트 사용량");
  expect(container.textContent).not.toContain("2026-10-06T");
  expect(container.textContent).not.toContain("최근 기록 8개");
  expect(historyRowIds()).toEqual(["8", "3", "1"]);

  const more = [...container.querySelectorAll("button")].find((button) => button.textContent === "더 읽기");
  await act(async () => more?.click());
  await settle();
  expect(calls.some((call) => call.includes("before=older-than-page"))).toBe(true);
  expect(historyRowIds()).toEqual(["8", "3", "1", "0"]);
});

it("distinguishes missing records, loading, and query failure without substituting zero values", async () => {
  const loadingRequest: typeof fetch = vi.fn(async () => await new Promise<Response>(() => undefined));
  await act(async () => root.render(<PersistentSessionMonitoring sessionId="loading-pas" nodeId="sample-node" request={loadingRequest} />));
  expect(container.textContent).toContain("불러오는 중…");
  expect(container.querySelectorAll("[role=alert]")).toHaveLength(0);

  const emptyRequest: typeof fetch = vi.fn(async (input) => {
    const url = new URL(String(input), "https://sample.invalid");
    return Response.json({ messages: [], next_cursor: null });
  });
  await act(async () => root.render(<PersistentSessionMonitoring sessionId="empty-pas" nodeId="sample-node" request={emptyRequest} />));
  await settle();
  expect(container.textContent).toContain("세대 기록 없음");
  expect(container.textContent).not.toContain("0.0%");
  expect(container.textContent?.match(/세대 기록 없음|기록 없음/g)).toHaveLength(1);

  const failedRequest: typeof fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
  await act(async () => root.render(<PersistentSessionMonitoring sessionId="failed-pas" nodeId="sample-node" request={failedRequest} />));
  await settle();
  expect(container.querySelectorAll("[role=alert]")).toHaveLength(1);
  expect(container.textContent?.match(/조회 실패/g)).toHaveLength(1);
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "다시 시도")).toBe(true);
});

it("retries the history read from its inline error action", async () => {
  let historyAttempts = 0;
  const request: typeof fetch = vi.fn(async (input) => {
    const url = new URL(String(input), "https://sample.invalid");
    if (url.pathname === "/api/nodes/sample-node/model-presets") return Response.json({ model_presets: [] });
    if (url.searchParams.get("event_types") === "generation_started") {
      return Response.json({ messages: [{ id: 3, event_type: "generation_started", payload: { generation: 3 }, created_at: "2026-10-06T02:00:00.000Z" }], next_cursor: null });
    }
    historyAttempts += 1;
    if (historyAttempts === 1) return new Response("unavailable", { status: 503 });
    return Response.json({ messages: [{ id: 3, event_type: "generation_started", payload: { generation: 3 }, created_at: "2026-10-06T02:00:00.000Z" }], next_cursor: null });
  });
  await act(async () => root.render(<PersistentSessionMonitoring sessionId="retry-pas" nodeId="sample-node" request={request} />));
  await settle();
  const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "다시 시도");
  expect(retry).toBeDefined();
  await act(async () => retry?.click());
  await settle();
  expect(historyAttempts).toBe(2);
  expect(container.textContent).not.toContain("조회 실패");
  expect(container.textContent).toContain("세대 3");
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function historyRowIds() {
  return [...container.querySelectorAll<HTMLElement>("[data-testid=persistent-session-history-row]")]
    .map((element) => element.dataset.eventId);
}
