/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InternalLinkProvider } from "@seosoyoung/soul-ui/components/InternalLinkProvider";
import { REPORT_TIMELINE_STATUS_LABEL, type ReportTimelineLine } from "@seosoyoung/soul-ui";
import { ReportTimelineRow } from "./ReportTimelineRow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const line = (overrides: Partial<ReportTimelineLine> = {}): ReportTimelineLine => ({
  line_key: "card-812",
  status: "review",
  title: "검수 요청",
  detail: "구현이 끝났습니다.",
  card_id: "card-812",
  card_number: 812,
  ...overrides,
});

describe("ReportTimelineRow", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  it.each(Object.entries(REPORT_TIMELINE_STATUS_LABEL))("shows the %s status label", (status, label) => {
    act(() => root?.render(<ReportTimelineRow line={line({ status: status as ReportTimelineLine["status"] })} alignmentInset="content" />));
    expect(host?.querySelector('[data-slot="status-chip"]')?.getAttribute("aria-label")).toBe(label);
  });

  it("keeps the report badge untoned, uses the card link, and opens it internally", () => {
    const openTarget = vi.fn();
    act(() => root?.render(
      <InternalLinkProvider internalOrigins={[window.location.origin]} openTarget={openTarget}>
        <ReportTimelineRow line={line({ status: "report" })} alignmentInset="avatar" />
      </InternalLinkProvider>,
    ));

    const row = host?.querySelector<HTMLAnchorElement>("a");
    expect(row?.getAttribute("href")).toBe("/?card=card-812");
    expect(row?.querySelector('[data-slot="status-chip"]')?.querySelector(".v3-status-dot")).toBeNull();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    act(() => row?.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(openTarget).toHaveBeenCalledWith({ kind: "card", cardId: "card-812" }, "/?card=card-812", expect.any(String));
  });

  it("uses a non-link row without a card and keeps long text in truncating spans", () => {
    act(() => root?.render(<ReportTimelineRow line={line({
      card_id: null,
      card_number: null,
      title: "제목이 좁은 화면에서 잘려야 하는 긴 제목".repeat(4),
      detail: "상황판과 질문의 긴 세부 내용".repeat(8),
    })} alignmentInset="content" />));
    const row = host?.querySelector("[data-slot='report-timeline-row']");
    expect(row?.tagName).toBe("DIV");
    expect(host?.querySelector("a")).toBeNull();
    expect(host?.querySelector('[data-slot="status-chip"]')?.className).toContain("shrink-0");
    expect(host?.querySelector('[data-slot="report-timeline-title"]')?.className).toContain("truncate");
    expect(host?.querySelector('[data-slot="report-timeline-detail"]')?.className).toContain("truncate");
    expect(row?.className).toContain("py-1");
  });

  it("adds only the existing avatar inset when requested", () => {
    act(() => root?.render(<ReportTimelineRow line={line()} alignmentInset="avatar" />));
    const row = host?.querySelector("[data-slot='report-timeline-row']");
    expect(row?.className).toContain("px-3");
    expect(row?.firstElementChild?.className).toContain("w-8");
  });
});
