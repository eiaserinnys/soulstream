/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UsageSummaryGauge, UsageSummaryNode } from "@seosoyoung/soul-ui";
import type { UseUsageSummaryResult } from "../hooks/useUsageSummary";
import { PersistentSessionWeeklyUsage } from "./PersistentSessionWeeklyUsage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const evaluatedAtMs = 1_800_000_000_000;
const node: UsageSummaryNode = {
  nodeId: "node-a",
  fetchedAt: "2026-10-13T08:00:00.000Z",
  stale: false,
  staleSince: null,
  providers: { claude: null, codex: null, gemini: null },
};
const gauges: UsageSummaryGauge[] = [
  { id: "claude", label: "Claude", remainingPercent: 73, resetAt: evaluatedAtMs / 1000 + 4 * 24 * 60 * 60 + 2 * 60 * 60 },
  { id: "codex", label: "Codex", remainingPercent: 41, resetAt: evaluatedAtMs / 1000 + 5 * 24 * 60 * 60 + 11 * 60 * 60 },
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function renderUsage(overrides: Partial<UseUsageSummaryResult> = {}, onNextNode = vi.fn(), onRetry = vi.fn()) {
  const props: UseUsageSummaryResult = {
    summary: null,
    node,
    gauges,
    maxGaugeCount: 3,
    loading: false,
    loadState: "ready",
    evaluatedAtMs,
    retry: onRetry,
    ...overrides,
  };
  act(() => root.render(<PersistentSessionWeeklyUsage {...props} onRetry={onRetry} onNextNode={onNextNode} />));
  return { onNextNode, onRetry };
}

it("shows compact reset labels, full accessible times, percentages, and a whole-row node action", () => {
  const { onNextNode } = renderUsage();

  const countdown = host.querySelector(".persistent-session-weekly-usage-countdown")!;
  expect(countdown.textContent).toBe("4일");
  expect(countdown.getAttribute("aria-label")).toBe("초기화까지 4일 2시간");
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
  expect(host.querySelector('[aria-label="Claude 주간 잔량"]')?.getAttribute("aria-valuenow")).toBe("73");
  expect(host.querySelector('[aria-label="Codex 주간 잔량"]')?.getAttribute("aria-valuenow")).toBe("41");
  expect(host.querySelectorAll(".persistent-session-weekly-usage-row[aria-hidden=\"true\"]")).toHaveLength(1);
  expect(host.querySelector(".persistent-session-weekly-usage-row.is-placeholder .persistent-session-weekly-usage-placeholder-labels")).not.toBeNull();

  const nodeButton = host.querySelector<HTMLButtonElement>('[aria-label="노드 바꾸기, 현재 node-a"]')!;
  expect(nodeButton.classList.contains("persistent-session-weekly-usage-node")).toBe(true);
  expect(nodeButton.textContent).toContain("node-a");
  const chevron = nodeButton.querySelector("svg");
  expect(chevron?.classList.contains("size-4")).toBe(true);
  expect(Number(chevron?.getAttribute("stroke-width"))).toBeCloseTo(1.4, 2);
  act(() => nodeButton.click());
  expect(onNextNode).toHaveBeenCalledOnce();
});

it("keeps stale values and the node row while putting the update time in the accessible description", () => {
  const staleNode = { ...node, stale: true };
  renderUsage({ node: staleNode, loadState: "connectionError" });

  const readout = host.querySelector('[data-testid="persistent-session-weekly-usage"]')!;
  expect(readout.getAttribute("title")).toContain("갱신 지연 · 마지막");
  expect(readout.textContent).not.toContain("갱신 지연");
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
  expect(host.querySelector('[aria-label="노드 바꾸기, 현재 node-a"]')).not.toBeNull();
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(0);
});

it("keeps one fixed status slot and exposes retry when no gauges are available", () => {
  const { onRetry } = renderUsage({
    node: null,
    gauges: [],
    loading: false,
    loadState: "connectionError",
  });

  expect(host.textContent).toContain("조회 실패");
  expect(host.querySelectorAll(".persistent-session-weekly-usage-row[aria-hidden=\"true\"]")).toHaveLength(2);
  const retry = host.querySelector<HTMLButtonElement>('[aria-label="주간 사용량 다시 시도"]')!;
  expect(retry).not.toBeNull();
  expect(retry.classList.contains("persistent-session-weekly-usage-retry")).toBe(true);
  act(() => retry.click());
  expect(onRetry).toHaveBeenCalledOnce();
  expect(host.querySelector('[aria-label^="노드 바꾸기"]')).toBeNull();
});

it("reserves three provider slots before the first usage summary arrives", () => {
  renderUsage({
    summary: null,
    node: null,
    gauges: [],
    maxGaugeCount: 0,
    loading: true,
    loadState: "idle",
  });

  expect(host.querySelector('[role="status"]')?.textContent).toBe("불러오는 중");
  expect(host.querySelectorAll(".persistent-session-weekly-usage-row.is-placeholder")).toHaveLength(2);
  expect(host.querySelector(".persistent-session-weekly-usage-node.is-placeholder")).not.toBeNull();
});
