/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { PersistentSessionMonitoring } from "./PersistentSessionMonitoring";
import type { PersistentSession } from "../lib/persistent-sessions";

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

it("reads the latest generation and paged history, then pairs real context and terminal usage", async () => {
  const calls: string[] = [];
  const request: typeof fetch = vi.fn(async (input) => {
    const url = new URL(String(input), "https://sample.invalid");
    calls.push(`${url.pathname}${url.search}`);
    if (url.searchParams.has("before")) return Response.json({ messages: [], next_cursor: null });
    if (url.searchParams.get("event_types") === "generation_started") {
      return Response.json({ messages: [{ id: 3, event_type: "generation_started", payload: {}, created_at: "2026-10-06T02:00:00.000Z" }], next_cursor: null });
    }
    return Response.json({
      messages: [
        { id: 5, event_type: "complete", payload: { usage: { input_tokens: 100, output_tokens: 50 }, turn_cost_usd: 0.42 }, created_at: "2026-10-06T02:01:00.000Z" },
        { id: 4, event_type: "context_usage", payload: { used_tokens: 220, max_tokens: 1000, percent: 22, estimated: false }, created_at: "2026-10-06T02:00:59.000Z" },
        { id: 3, event_type: "generation_started", payload: {}, created_at: "2026-10-06T02:00:00.000Z" },
      ],
      next_cursor: "older-than-page",
    });
  });

  await act(async () => root.render(<PersistentSessionMonitoring resource={session()} sessionId="sample-pas" nodeId="sample-node" request={request} />));
  await settle();

  expect(calls).toContain("/api/sessions/sample-pas/timeline?event_types=generation_started&limit=1");
  expect(calls).toContain("/api/sessions/sample-pas/timeline?event_types=generation_started%2Ccomplete%2Ccontext_usage&limit=100");
  expect(container.textContent).toContain("2026-10-06T02:00:00.000Z");
  expect(valueFor("최근 턴 사용량")).toContain("컨텍스트 22.0%");
  expect(valueFor("최근 턴 사용량")).toContain("컨텍스트 220 / 1,000 (22.0%)");
  expect(valueFor("최근 턴 사용량")).toContain("입력 100 · 출력 50 · 정가 $0.42");
  expect(valueFor("최근 기록")).toBe("3개");

  const more = [...container.querySelectorAll("button")].find((button) => button.textContent === "더 읽기");
  await act(async () => more?.click());
  await settle();
  expect(calls.some((call) => call.includes("before=older-than-page"))).toBe(true);
});

it("distinguishes missing records, loading, and query failure without substituting zero values", async () => {
  const loadingRequest: typeof fetch = vi.fn(async () => await new Promise<Response>(() => undefined));
  await act(async () => root.render(<PersistentSessionMonitoring resource={session()} sessionId="loading-pas" nodeId="sample-node" request={loadingRequest} />));
  expect(valueFor("현재 세대")).toBe("불러오는 중…");
  expect(valueFor("최근 턴 사용량")).toBe("불러오는 중…");

  const emptyRequest: typeof fetch = vi.fn(async (input) => {
    const url = new URL(String(input), "https://sample.invalid");
    return Response.json({ messages: [], next_cursor: null });
  });
  await act(async () => root.render(<PersistentSessionMonitoring resource={session()} sessionId="empty-pas" nodeId="sample-node" request={emptyRequest} />));
  await settle();
  expect(valueFor("현재 세대")).toBe("세대 기록 없음");
  expect(valueFor("최근 턴 사용량")).toBe("기록 없음");
  expect(valueFor("최근 기록")).toBe("기록 없음");
  expect(valueFor("최근 턴 사용량")).not.toContain("0.0%");

  const failedRequest: typeof fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
  await act(async () => root.render(<PersistentSessionMonitoring resource={session()} sessionId="failed-pas" nodeId="sample-node" request={failedRequest} />));
  await settle();
  expect(valueFor("현재 세대")).toContain("조회 실패");
  expect(valueFor("최근 턴 사용량")).toContain("조회 실패");
  expect(valueFor("현재 세대")).not.toContain("세대 기록 없음");
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function valueFor(label: string) {
  const row = [...container.querySelectorAll<HTMLElement>("[data-testid=config-field-row]")]
    .find((element) => element.textContent?.includes(label));
  return row?.querySelector<HTMLInputElement>("input")?.value;
}

function session(): PersistentSession {
  return {
    session_id: "sample-pas",
    display_name: "검수 세션",
    node_id: "sample-node",
    folder_id: "sample-folder",
    agent_id: "roselin",
    agent_name: "로젤린",
    persistent: true,
    settings: {
      default_model: { model_preset: "sample-opus", reasoning_effort: null },
      fallback_model: null,
      show_generation_separator: true,
      show_character: true,
      animate_character: true,
      show_jev_candidates: true,
      show_turn_usage: true,
    },
    runtime: {
      current_model: { model_preset: "sample-sol", model: "sample-sol-model", reasoning_effort: "high" },
      pending: { target_model_preset: "sample-opus", target_reasoning_effort: null },
    },
  };
}
