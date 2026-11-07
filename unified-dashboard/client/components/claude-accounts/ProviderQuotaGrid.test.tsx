/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaSlot, ProviderQuotaSlots } from "@seosoyoung/soul-ui";
import { ProviderQuotaGrid, formatQuotaResetLabel } from "./ProviderQuotaGrid";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function slot(kind: ProviderQuotaSlot["kind"], label: string, usedPercent: number, resetAt: number | null = null): ProviderQuotaSlot {
  return { kind, label, usedPercent, resetAt };
}

const releaseTime = (epochSeconds: number) => new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(new Date(epochSeconds * 1000));

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

  it("shows the weekday time for resets farther out", () => {
    const resetAt = Math.floor(Date.parse("2030-01-02T05:00:00Z") / 1000);
    const weekday = new Intl.DateTimeFormat("ko-KR", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(resetAt * 1000));
    expect(formatQuotaResetLabel(resetAt, 40)).toBe(weekday);
  });

  it("shows the release time when the window is exhausted", () => {
    const resetAt = Math.floor(Date.parse("2030-01-02T05:00:00Z") / 1000);
    expect(formatQuotaResetLabel(resetAt, 100)).toBe(`${releaseTime(resetAt)} 해제`);
  });
});
