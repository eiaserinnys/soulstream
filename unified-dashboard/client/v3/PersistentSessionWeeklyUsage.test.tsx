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
  providers: { claude: null, codex: null, antigravity: null },
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
    loading: false,
    loadState: "ready",
    evaluatedAtMs,
    retry: onRetry,
    ...overrides,
  };
  act(() => root.render(<PersistentSessionWeeklyUsage {...props} onRetry={onRetry} onNextNode={onNextNode} />));
  return { onNextNode, onRetry };
}

it("shows compact reset labels, full accessible times, percentages, and a whole-row node action without empty slots", () => {
  const { onNextNode } = renderUsage();

  const countdown = host.querySelector(".persistent-session-weekly-usage-countdown")!;
  expect(countdown.textContent).toBe("4일");
  expect(countdown.getAttribute("aria-label")).toBe("초기화까지 4일 2시간");
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
  expect(host.querySelector('[aria-label="Claude 주간 잔량"]')?.getAttribute("aria-valuenow")).toBe("73");
  expect(host.querySelector('[aria-label="Codex 주간 잔량"]')?.getAttribute("aria-valuenow")).toBe("41");
  expect(host.querySelectorAll(".persistent-session-weekly-usage-row[aria-hidden=\"true\"]")).toHaveLength(0);

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
  expect(readout.getAttribute("title")).toContain("갱신 지연, 마지막");
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
    loading: true,
    loadState: "idle",
  });

  expect(host.querySelector('[role="status"]')?.textContent).toBe("불러오는 중");
  expect(host.querySelectorAll(".persistent-session-weekly-usage-row.is-placeholder")).toHaveLength(2);
  expect(host.querySelector(".persistent-session-weekly-usage-node.is-placeholder")).not.toBeNull();
});

it.each([1, 2, 3, 4])("renders exactly %i gauges without empty slots", count => {
  const four: UsageSummaryGauge[] = [gauges[0], { ...gauges[0], id: 'fable', label: 'Fable' }, gauges[1], { ...gauges[0], id: 'antigravity', label: 'Antigravity' }];
  renderUsage({ gauges: four.slice(0, count) });
  expect(host.querySelectorAll('.persistent-session-weekly-usage-row')).toHaveLength(count);
  expect(host.querySelector('.persistent-session-weekly-usage-row.is-placeholder')).toBeNull();
  expect(host.querySelector('.persistent-session-weekly-usage')?.lastElementChild?.classList.contains('persistent-session-weekly-usage-node')).toBe(true);
});

function nodeWithClaudePool(available: number, total: number, best: number | null, earliest: string | null = null): UsageSummaryNode {
  return {
    ...node,
    providers: {
      ...node.providers,
      claude: {
        status: "auto",
        weeklyRemainingPercent: available === 0 && total >= 2 ? null : 73,
        weeklyResetAt: available === 0 && total >= 2 ? null : evaluatedAtMs / 1000 + 4 * 24 * 60 * 60,
        shortRemainingPercent: null,
        shortResetAt: null,
        quotas: [],
        mode: "pool",
        accounts: [],
        pool: {
          available_count: available,
          total_count: total,
          best_weekly_remaining_percent: best,
          best_weekly_resets_at: null,
          earliest_available_at: earliest,
        },
        fable_pool: null,
      } as UsageSummaryNode["providers"]["claude"],
    },
  };
}

it("keeps legacy and one-account PAS labels unchanged", () => {
  renderUsage({ node: nodeWithClaudePool(1, 1, 45) });
  expect(host.querySelector('[aria-label="Claude 주간 잔량"]')?.getAttribute("aria-valuenow")).toBe("73");
  expect(host.querySelector(".persistent-session-weekly-usage-provider")?.textContent).toBe("Claude");

  renderUsage({ node: nodeWithClaudePool(0, 1, 0, "2030-01-01T03:45:00.000Z") });
  expect(host.querySelector('[aria-label="Claude 주간 잔량"]')?.getAttribute("aria-valuenow")).toBe("73");
  expect(host.querySelector(".persistent-session-weekly-usage-pool-count")).toBeNull();
  expect(host.querySelector(".persistent-session-weekly-usage-countdown")?.textContent).toBe("4일");
});

it("shows pool availability and best remaining usage for multi-account PAS", () => {
  renderUsage({ node: nodeWithClaudePool(2, 3, 62) });
  expect(host.querySelector(".persistent-session-weekly-usage-provider")?.textContent).toBe("Claude2/3");
  expect(host.querySelector('[aria-label="Claude 주간 잔량"]')?.getAttribute("aria-valuenow")).toBe("62");

  renderUsage({ node: nodeWithClaudePool(1, 3, 41) });
  expect(host.querySelector(".persistent-session-weekly-usage-pool-count")?.getAttribute("data-warn")).toBe("true");
  expect(host.querySelector('[aria-label="Claude 주간 잔량"]')?.classList.contains("is-warning")).toBe(false);
});

it("shows the local earliest recovery time and zero percent when every account is blocked", () => {
  const earliest = "2030-01-01T03:45:00.000Z";
  renderUsage({
    node: nodeWithClaudePool(0, 2, 0, earliest),
    gauges: [gauges[1]],
  });
  expect(host.querySelector('[aria-label="Claude 주간 잔량"]')).not.toBeNull();
  const localTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(earliest));
  expect(host.querySelector('[aria-label="Claude 주간 잔량"]')?.previousElementSibling?.textContent).toContain(`${localTime} 해제`);
  expect(host.querySelector('[aria-label="Claude 주간 잔량"]')?.previousElementSibling?.textContent).toContain("0%");
  expect(host.querySelector('[aria-label="Claude 주간 잔량"]')?.getAttribute("aria-valuenow")).toBe("0");
});
