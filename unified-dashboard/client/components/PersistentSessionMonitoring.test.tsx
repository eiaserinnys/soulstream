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
  expect(calls).toContain("/api/sessions/sample-pas/timeline?event_types=debug&debug_kinds=persistent_decision&limit=1");
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
  expect(container.querySelector('[aria-label="최근 기록"]')).toBeNull();
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
    if (url.searchParams.has("debug_kinds")) return Response.json({ messages: [], next_cursor: null });
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


it.each([
  ["weekly_headroom", "주간 사용 여유"],
  ["settings", "설정 변경"],
  ["target model preset unavailable", "모델 사용 불가"],
  ["unknown_internal_reason", "세대 교체"],
] as const)("translates generation reason %s", async (reason, label) => {
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input), "https://sample.invalid");
    if (url.pathname.includes("model-presets")) return Response.json({ model_presets: [] });
    const current = url.searchParams.get("event_types") === "generation_started";
    return Response.json({ messages: [{ id: current ? 2 : 1, event_type: "generation_started", payload: { reason, current: { model: "example-model" } }, created_at: "2026-10-06T02:00:00.000Z" }], next_cursor: null });
  };
  await act(async () => root.render(<PersistentSessionMonitoring sessionId="reason-pas" nodeId="sample-node" request={request} />));
  await settle();
  expect(container.querySelector('[data-testid="persistent-session-history-row"] p')?.textContent).toBe(`${label} · example-model`);
});

it("retries only the failed older page and preserves already loaded rows", async () => {
  const calls: string[] = [];
  let olderAttempts = 0;
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input), "https://sample.invalid");
    if (url.pathname.includes("model-presets")) return Response.json({ model_presets: [] });
    calls.push(url.search);
    if (url.searchParams.get("event_types") === "generation_started") return Response.json({ messages: [], next_cursor: null });
    if (url.searchParams.has("before") && ++olderAttempts === 1) return new Response("unavailable", { status: 503 });
    const older = url.searchParams.has("before");
    return Response.json({ messages: [{ id: older ? 1 : 2, event_type: "complete", payload: { turn_cost_usd: 0.5 }, created_at: "2026-10-06T02:00:00.000Z" }], next_cursor: older ? null : "older-page" });
  };
  await act(async () => root.render(<PersistentSessionMonitoring sessionId="page-pas" nodeId="sample-node" request={request} />));
  await settle();
  const more = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "더 읽기");
  await act(async () => more()?.click());
  await settle();
  expect(container.textContent).toContain("조회 실패");
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["더 읽기"]);
  expect(historyRowIds()).toEqual(["2"]);
  await act(async () => more()?.click());
  await settle();
  expect(historyRowIds()).toEqual(["2", "1"]);
  expect(calls.filter((query) => query.includes("before=older-page"))).toHaveLength(2);
  expect(calls.filter((query) => !query.includes("before=") && !query.includes("event_types=generation_started&") && !query.includes("debug_kinds="))).toHaveLength(1);
  expect(container.textContent).not.toContain("조회 실패");
});

it("requests the latest persistent decision separately and renders it below the generation row", async () => {
  const calls: URL[] = [];
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input), "https://sample.invalid");
    calls.push(url);
    if (url.pathname.includes("model-presets")) return Response.json({ model_presets: [] });
    if (url.searchParams.get("event_types") === "generation_started") return Response.json({
      messages: [{ id: 40, event_type: "generation_started", payload: { generation: 7 }, created_at: "2026-10-06T02:00:00.000Z" }],
      next_cursor: null,
    });
    if (url.searchParams.has("debug_kinds")) return Response.json({
      messages: [
        { id: 21, event_type: "debug", payload: { kind: "persistent_decision", trigger: "turn_end", action: "wait_until", rule: "newest", reason: "다음 확인 시각까지 기다립니다.", inputs_snapshot: {} }, created_at: "2026-10-06T03:00:00.000Z" },
        { id: 22, event_type: "debug", payload: { kind: "persistent_decision", trigger: "turn_end", action: "new_generation", rule: "older", reason: "사용 여유를 확인합니다.", inputs_snapshot: {} }, created_at: "2026-10-06T02:00:00.000Z" },
      ],
      next_cursor: null,
    });
    return Response.json({
      messages: [],
      next_cursor: null,
    });
  };

  await act(async () => root.render(<PersistentSessionMonitoring sessionId="decision-pas" nodeId="sample-node" request={request} />));
  await settle();

  expect(calls.some((url) => url.searchParams.get("event_types") === "generation_started,complete,context_usage,error,user_message,intervention_sent" && !url.searchParams.has("debug_kinds"))).toBe(true);
  const decisionRequest = calls.find((url) => url.searchParams.get("debug_kinds") === "persistent_decision");
  expect(decisionRequest?.searchParams.get("event_types")).toBe("debug");
  expect(decisionRequest?.searchParams.get("limit")).toBe("1");
  expect(decisionRequest?.searchParams.getAll("debug_kinds")).toEqual(["persistent_decision"]);
  const rows = [...container.querySelectorAll<HTMLElement>("[data-testid=config-field-row]")];
  const rowLabel = (row: HTMLElement) => row.querySelector("span")?.textContent;
  const generationIndex = rows.findIndex((row) => rowLabel(row) === "현재 세대");
  const decisionIndex = rows.findIndex((row) => rowLabel(row) === "마지막 판단");
  expect(decisionIndex).toBe(generationIndex + 1);
  expect(rows[decisionIndex]?.textContent).toContain(new Date("2026-10-06T03:00:00.000Z").toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  expect(rows[decisionIndex]?.textContent).toContain("wait_until");
  expect(rows[decisionIndex]?.textContent).toContain("다음 확인 시각까지 기다립니다.");
  expect(rows[decisionIndex]?.textContent).not.toContain("사용 여유를 확인합니다.");
});

it("does not render a last-decision row when monitoring history has no decision", async () => {
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input), "https://sample.invalid");
    if (url.pathname.includes("model-presets")) return Response.json({ model_presets: [] });
    if (url.searchParams.get("event_types") === "generation_started") return Response.json({
      messages: [{ id: 30, event_type: "generation_started", payload: { generation: 4 }, created_at: "2026-10-06T02:00:00.000Z" }],
      next_cursor: null,
    });
    if (url.searchParams.has("debug_kinds")) return Response.json({ messages: [], next_cursor: null });
    return Response.json({ messages: [], next_cursor: null });
  };

  await act(async () => root.render(<PersistentSessionMonitoring sessionId="no-decision-pas" nodeId="sample-node" request={request} />));
  await settle();

  expect([...container.querySelectorAll("[data-testid=config-field-row] span")].map((span) => span.textContent)).not.toContain("마지막 판단");
});

it("hides only the last-decision row when its dedicated request fails", async () => {
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input), "https://sample.invalid");
    if (url.pathname.includes("model-presets")) return Response.json({ model_presets: [] });
    if (url.searchParams.has("debug_kinds")) return new Response("unavailable", { status: 503 });
    if (url.searchParams.get("event_types") === "generation_started") return Response.json({
      messages: [{ id: 31, event_type: "generation_started", payload: { generation: 5 }, created_at: "2026-10-06T02:00:00.000Z" }],
      next_cursor: null,
    });
    return Response.json({ messages: [], next_cursor: null });
  };

  await act(async () => root.render(<PersistentSessionMonitoring sessionId="decision-error-pas" nodeId="sample-node" request={request} />));
  await settle();

  expect(container.textContent).toContain("세대 5");
  expect(container.textContent).toContain("조회 실패: 기록을 불러오지 못했습니다 (503)");
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "다시 시도")).toBe(true);
  const generationRow = [...container.querySelectorAll<HTMLElement>("[data-testid=config-field-row]")]
    .find((row) => row.querySelector("span")?.textContent === "현재 세대");
  const decisionError = [...container.querySelectorAll<HTMLElement>("[role=alert]")]
    .find((alert) => alert.textContent?.includes("조회 실패: 기록을 불러오지 못했습니다 (503)"));
  expect(decisionError?.parentElement?.previousElementSibling).toBe(generationRow);
  expect([...container.querySelectorAll("[data-testid=config-field-row] span")].map((span) => span.textContent)).not.toContain("마지막 판단");
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function historyRowIds() {
  return [...container.querySelectorAll<HTMLElement>("[data-testid=persistent-session-history-row]")]
    .map((element) => element.dataset.eventId);
}
