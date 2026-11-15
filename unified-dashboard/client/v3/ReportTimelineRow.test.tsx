/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InternalLinkProvider } from "@seosoyoung/soul-ui/components/InternalLinkProvider";
import { REPORT_TIMELINE_STATUS_LABEL, type ReportTimelineRowLine } from "@seosoyoung/soul-ui";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { ReportTimelineRow } from "./ReportTimelineRow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const line = (overrides: Partial<ReportTimelineRowLine> = {}): ReportTimelineRowLine => ({
  line_key: "card-812",
  status: "review",
  title: "검수 요청",
  detail: "구현이 끝났습니다.",
  card_id: "card-812",
  card_number: 812,
  ...overrides,
});

const cardRow = (overrides: Partial<CardRow> = {}): CardRow => ({
  id: "card-812", folderId: "folder", title: "실행 중 카드", request: "", brief: "", attachments: [],
  status: "running", blockedKind: null, blockedDetail: null, positionKey: "a", queuePositionKey: null,
  assigneeKind: "session", assigneeAgentId: "roselin", assigneeUserId: null, assigneeSessionId: "session",
  nodeId: "eiaserinnys", modelPreset: "codex-6-luna", version: 2, archived: false,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...overrides,
});

describe("ReportTimelineRow", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  beforeEach(() => {
    useCardStore.setState({ byId: {}, details: {}, errors: {}, pendingItemConfirmations: {}, folderIds: {} });
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
    act(() => root?.render(<ReportTimelineRow line={line({ status: status as ReportTimelineRowLine["status"] })} alignmentInset="content" />));
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

  it("shows the live card status, title and situation instead of the recorded line", () => {
    useCardStore.setState({ byId: { "card-812": cardRow({
      status: "running", title: "실행 중 카드",
      now: { text: "작업 중", turn: "agent", ask: null, updatedAt: "2026-10-01T00:00:00Z", sessionId: "session" },
    }) } });
    act(() => root?.render(<ReportTimelineRow line={line()} alignmentInset="content" />));

    expect(host?.querySelector('[data-slot="status-chip"]')?.getAttribute("aria-label")).toBe("실행 중");
    expect(host?.querySelector('[data-slot="report-timeline-title"]')?.textContent).toBe("실행 중 카드");
    expect(host?.querySelector('[data-slot="report-timeline-detail"]')?.textContent).toBe("작업 중");
  });

  it("uses the live question block, and clears situation text once the card is done", () => {
    useCardStore.setState({ byId: { "card-812": cardRow({ status: "blocked", blockedKind: "question" }) } });
    act(() => root?.render(<ReportTimelineRow line={line({ status: "running" })} alignmentInset="content" />));
    expect(host?.querySelector('[data-slot="status-chip"]')?.getAttribute("aria-label")).toBe("질문");

    act(() => useCardStore.setState({ byId: { "card-812": cardRow({ status: "done", title: "끝난 카드" }) } }));
    act(() => root?.render(<ReportTimelineRow line={line()} alignmentInset="content" />));
    expect(host?.querySelector('[data-slot="status-chip"]')?.getAttribute("aria-label")).toBe("완료");
    expect(host?.querySelector('[data-slot="report-timeline-title"]')?.textContent).toBe("끝난 카드");
    expect(host?.querySelector('[data-slot="report-timeline-detail"]')).toBeNull();
  });

  it("leaves question and report rows to their recorded line", () => {
    useCardStore.setState({ byId: { "card-812": cardRow({ status: "running" }) } });
    act(() => root?.render(<ReportTimelineRow line={line({
      status: "question", question_id: "q-1", title: "질문 카드",
    })} alignmentInset="content" />));
    expect(host?.querySelector('[data-slot="status-chip"]')?.getAttribute("aria-label")).toBe("질문");
    expect(host?.querySelector('[data-slot="report-timeline-title"]')?.textContent).toBe("질문 카드");

    act(() => root?.render(<ReportTimelineRow line={line({ status: "report", title: "보고 줄" })} alignmentInset="content" />));
    expect(host?.querySelector('[data-slot="status-chip"]')?.getAttribute("aria-label")).toBe("보고");
    expect(host?.querySelector('[data-slot="report-timeline-title"]')?.textContent).toBe("보고 줄");
  });

  it("adds only the existing avatar inset when requested", () => {
    act(() => root?.render(<ReportTimelineRow line={line()} alignmentInset="avatar" />));
    const row = host?.querySelector("[data-slot='report-timeline-row']");
    expect(row?.className).toContain("px-3");
    expect(row?.firstElementChild?.className).toContain("w-8");
  });
});
