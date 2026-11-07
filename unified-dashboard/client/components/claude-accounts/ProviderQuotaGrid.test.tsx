/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaSlot, ProviderQuotaSlots } from "@seosoyoung/soul-ui";
import { ProviderQuotaGrid, ProviderQuotaSkeleton, formatQuotaResetLabel } from "./ProviderQuotaGrid";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function slot(kind: ProviderQuotaSlot["kind"], label: string, usedPercent: number, resetAt: number | null = null): ProviderQuotaSlot {
  return { kind, label, usedPercent, resetAt };
}

const releaseTime = (epochSeconds: number) => new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(new Date(epochSeconds * 1000));

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

const dateLabel = (epochSeconds: number) => {
  const date = new Date(epochSeconds * 1000);
  return `${date.getMonth() + 1}/${date.getDate()}`;
};

describe("ProviderQuotaGrid", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  async function mount(slots: ProviderQuotaSlots) {
    await act(async () => root.render(<ProviderQuotaGrid slots={slots} label="사용량" />));
  }

  it("keeps three columns and leaves a null slot empty so the remaining slots keep their column", async () => {
    await mount([null, slot("weekly", "7일", 20), null]);

    const cells = Array.from(host.querySelectorAll<HTMLElement>(".c724-quota-cell"));
    expect(cells).toHaveLength(3);
    expect(cells[0]?.textContent).toBe("");
    expect(cells[1]?.querySelector(".c724-quota-name")?.textContent).toBe("7일");
    expect(cells[1]?.querySelector(".c724-quota-pct")?.textContent).toBe("20%");
    expect(cells[2]?.textContent).toBe("");
    expect(cells[1]?.querySelector(".c724-quota-fill")).not.toBeNull();
  });

  it("rounds the used percent and renders the bar width from it", async () => {
    await mount([slot("short", "5시간", 12.6), null, null]);

    const cell = host.querySelector<HTMLElement>(".c724-quota-cell")!;
    expect(cell.querySelector(".c724-quota-pct")?.textContent).toBe("13%");
    expect(cell.querySelector<HTMLElement>(".c724-quota-fill")?.style.width).toBe("12.6%");
  });

  it("puts the name, percent and reset label directly in the label row", async () => {
    await mount([slot("short", "5시간", 12, Math.floor(Date.now() / 1000) + 3600), null, null]);

    const row = host.querySelector(".c724-quota-label-row")!;
    expect(Array.from(row.children).map((child) => child.className)).toEqual([
      "c724-quota-name",
      "c724-quota-pct",
      "c724-quota-reset",
    ]);
  });

  it("keeps the same three direct children in the skeleton label row so the loaded heights match", async () => {
    await act(async () => root.render(<ProviderQuotaSkeleton />));

    const row = host.querySelector(".c724-quota-skeleton-label")!;
    expect(Array.from(row.children).map((child) => child.className)).toEqual([
      "c724-quota-name",
      "c724-quota-pct",
      "c724-quota-reset",
    ]);
  });
});

describe("formatQuotaResetLabel", () => {
  it("returns an empty label without a reset time", () => {
    expect(formatQuotaResetLabel(null, 40)).toBe("");
  });

  it("shows minutes and hours until the reset inside twelve hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    const now = Date.now();
    expect(formatQuotaResetLabel(Math.ceil((now + 30 * 60_000) / 1000), 40)).toBe("30분 후");
    expect(formatQuotaResetLabel(Math.ceil((now + 2 * 60 * 60_000) / 1000), 40)).toBe("2시간 후");
  });

  it("writes the weekday without parentheses for a short window farther out", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    const resetAt = Math.ceil((Date.now() + 2 * 86_400_000) / 1000);
    const weekday = WEEKDAYS[new Date(resetAt * 1000).getDay()];
    expect(formatQuotaResetLabel(resetAt, 40)).toBe(`${weekday} ${releaseTime(resetAt)}`);
    expect(formatQuotaResetLabel(resetAt, 40)).not.toContain("(");
  });

  it("writes a date instead of a weekday for a monthly window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    const resetAt = Math.ceil((Date.now() + 3 * 86_400_000) / 1000);
    expect(formatQuotaResetLabel(resetAt, 40, "monthly")).toBe(dateLabel(resetAt));
    expect(formatQuotaResetLabel(resetAt, 40)).not.toBe(dateLabel(resetAt));
  });

  it("writes a date for a window farther out than a week even without the monthly kind", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    const resetAt = Math.ceil((Date.now() + 9 * 86_400_000) / 1000);
    expect(formatQuotaResetLabel(resetAt, 40)).toBe(dateLabel(resetAt));
  });

  it("rounds the used percent before deciding the window is exhausted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    const resetAt = Math.ceil((Date.now() + 2 * 60 * 60_000) / 1000);
    expect(formatQuotaResetLabel(resetAt, 99.6)).toBe(`${releaseTime(resetAt)} 해제`);
    expect(formatQuotaResetLabel(resetAt, 99.4)).toBe("2시간 후");
  });

  it("shows the release date when a monthly window is exhausted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    const resetAt = Math.ceil((Date.now() + 3 * 86_400_000) / 1000);
    expect(formatQuotaResetLabel(resetAt, 100, "monthly")).toBe(`${dateLabel(resetAt)} 해제`);
    expect(formatQuotaResetLabel(resetAt, 100)).toBe(`${releaseTime(resetAt)} 해제`);
  });
});
