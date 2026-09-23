/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDashboardStore,
  type CatalogState,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import type {
  SearchNavigationResult,
  SearchResultItem,
  SearchSessionResult,
} from "../hooks/useSessionSearch";

const searchHarness = vi.hoisted(() => ({
  results: [] as SearchResultItem[],
  navigationResults: [] as Array<
    | {
      kind: "folder";
      id: string;
      title: string;
      folder_id: string;
      project_page_id: string;
    }
    | {
      kind: "task";
      id: string;
      title: string;
      folder_id: string;
      project_page_id: string;
      board_item_id: string;
      task_page_id: string;
    }
  >,
  sessionResults: [] as SearchSessionResult[],
  searchStatus: null as null | {
    search?: { status: "partial"; stage: "lexical" | "semantic" | "navigation"; reason: "timeout" | "cancelled" };
    query_expansion?: { status: "expanded" | "skipped" | "partial"; reason?: string; latency_ms: number };
  },
  expansionPending: false,
  expansionFailed: false,
  search: vi.fn(),
  clear: vi.fn(),
  invalidate: vi.fn(),
  currentSearchFlowId: vi.fn(() => "search-flow-1"),
}));

vi.mock("../hooks/useSessionSearch", () => ({
  useSessionSearch: () => ({
    results: searchHarness.results,
    navigationResults: searchHarness.navigationResults,
    sessionResults: searchHarness.sessionResults,
    searchStatus: searchHarness.searchStatus,
    loading: false,
    expansionPending: searchHarness.expansionPending,
    expansionFailed: searchHarness.expansionFailed,
    error: null,
    search: searchHarness.search,
    clear: searchHarness.clear,
    invalidate: searchHarness.invalidate,
    currentSearchFlowId: searchHarness.currentSearchFlowId,
  }),
}));

import { SearchModal } from "./SearchModal";

function makeSession(
  agentSessionId: string,
  folderId: string | null,
  displayName: string | null = null,
): SessionSummary {
  return {
    agentSessionId,
    status: "running",
    eventCount: 0,
    folderId,
    displayName,
  };
}

function makeCatalog(session: SessionSummary): CatalogState {
  return {
    folders: [
      { id: "current-folder", name: "Current", sortOrder: 0 },
      { id: "target-folder", name: "Target", sortOrder: 1 },
    ],
    sessions: {
      [session.agentSessionId]: {
        folderId: session.folderId ?? null,
        displayName: "Catalog target",
      },
    },
    sessionList: [session],
  };
}

function renderSearchModal(options: {
  sessions?: SessionSummary[];
  onOpenChange?: (open: boolean) => void;
  onOpenSession?: (
    sessionId: string,
    focusEventId: number | null,
    session?: SessionSummary,
  ) => boolean | void | Promise<boolean | void>;
  onOpenFolder?: (
    result: Extract<SearchNavigationResult, { kind: "folder" }>,
  ) => void;
  onOpenTask?: (
    result: Extract<SearchNavigationResult, { kind: "task" }>,
  ) => void;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onOpenChange = options.onOpenChange ?? vi.fn();

  flushSync(() => {
    root.render(createElement(SearchModal, {
      open: true,
      onOpenChange,
      sessions: options.sessions ?? [],
      onOpenSession: options.onOpenSession,
      onOpenFolder: options.onOpenFolder,
      onOpenTask: options.onOpenTask,
    }));
  });

  return { container, root, onOpenChange };
}

function clickResult(preview: string) {
  const resultButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.includes(preview));
  expect(resultButton).not.toBeUndefined();

  flushSync(() => {
    resultButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setTextInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  expect(valueSetter).toBeTypeOf("function");
  flushSync(() => {
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SearchModal", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });
    useDashboardStore.getState().reset();
    searchHarness.results = [];
    searchHarness.navigationResults = [];
    searchHarness.sessionResults = [];
    searchHarness.searchStatus = null;
    searchHarness.expansionPending = false;
    searchHarness.expansionFailed = false;
    searchHarness.search.mockReset();
    searchHarness.clear.mockReset();
    searchHarness.invalidate.mockReset();
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    container?.remove();
    document.body.innerHTML = "";
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("activates the selected session summary and folder when clicking a search result", () => {
    const target = makeSession("target-session", "target-folder");
    useDashboardStore.getState().setCatalog(makeCatalog(target));
    useDashboardStore.getState().selectFolder("current-folder");
    searchHarness.results = [
      {
        session_id: "target-session",
        event_id: 42,
        score: 1,
        preview: "Needle preview",
        event_type: "user_message",
        match_source: "message",
      },
    ];

    ({ container, root } = renderSearchModal({ sessions: [] }));

    clickResult("Needle preview");

    const state = useDashboardStore.getState();
    expect(state.selectedFolderId).toBe("target-folder");
    expect(state.activeSessionKey).toBe("target-session");
    expect(state.activeSessionSummary).toMatchObject({
      agentSessionId: "target-session",
      folderId: "target-folder",
      displayName: "Catalog target",
    });
    expect(state.focusEventId).toBe(42);
  });

  it("keeps the same-session overlay reset path when selecting the active session from search", () => {
    const target = makeSession("target-session", "target-folder");
    useDashboardStore.getState().setCatalog(makeCatalog(target));
    useDashboardStore.getState().selectFolder("target-folder");
    useDashboardStore.getState().setActiveSessionSummary(target);
    useDashboardStore.getState().setActiveSession("target-session");
    useDashboardStore.getState().setActiveBoardDocument("doc-1");
    searchHarness.results = [
      {
        session_id: "target-session",
        event_id: 88,
        score: 1,
        preview: "Same session preview",
        event_type: "assistant_message",
        match_source: "message",
      },
    ];

    ({ container, root } = renderSearchModal({ sessions: [target] }));

    clickResult("Same session preview");

    const state = useDashboardStore.getState();
    expect(state.activeSessionKey).toBe("target-session");
    expect(state.activeBoardDocumentId).toBeNull();
    expect(state.activeRightTab).toBe("chat");
    expect(state.focusEventId).toBe(88);
  });

  it("delegates a selected result to the host session opener when one is provided", () => {
    const current = makeSession("current-session", "current-folder");
    const target = makeSession("target-session", "target-folder");
    const onOpenSession = vi.fn();
    useDashboardStore.getState().setCatalog(makeCatalog(target));
    useDashboardStore.getState().selectFolder("current-folder");
    useDashboardStore.getState().setActiveSessionSummary(current);
    useDashboardStore.getState().setActiveSession("current-session");
    searchHarness.results = [
      {
        session_id: "target-session",
        event_id: 91,
        score: 1,
        preview: "Delegated preview",
        event_type: "user_message",
        match_source: "message",
      },
    ];

    ({ container, root } = renderSearchModal({ onOpenSession }));

    clickResult("Delegated preview");

    expect(onOpenSession).toHaveBeenCalledWith(
      "target-session",
      91,
      expect.objectContaining({
        agentSessionId: "target-session",
        folderId: "target-folder",
      }),
    );
    expect(useDashboardStore.getState().selectedFolderId).toBe("current-folder");
    expect(useDashboardStore.getState().activeSessionKey).toBe("current-session");
    expect(useDashboardStore.getState().focusEventId).toBeNull();
  });

  it("shows one session row instead of duplicating its event row and opens its exact best event", async () => {
    const target = makeSession("target-session", "target-folder");
    const onOpenSession = vi.fn().mockResolvedValue(true);
    searchHarness.sessionResults = [{
      session_id: "target-session",
      title: "Target work",
      excerpt: "Related work excerpt",
      updated_at: "2026-09-23T00:00:00Z",
      task_id: "task-a",
      task_title: "Linked task",
      parent_session_id: null,
      best_match: { event_id: 42, match_source: "message", excerpt: "Related work excerpt" },
      evidence: [{ source: "message", event_id: 42, excerpt: "Related work excerpt" }],
      session_url: "/?session=target-session&event=42",
    }];
    searchHarness.results = [{
      session_id: "target-session",
      event_id: 42,
      score: 1,
      preview: "Related work excerpt",
      event_type: "user_message",
      match_source: "message",
    }];

    ({ container, root } = renderSearchModal({ sessions: [target], onOpenSession }));

    expect(document.body.querySelectorAll('[data-testid="session-search-result"]')).toHaveLength(1);
    expect(document.body.textContent).toContain("Linked task");
    clickResult("Related work excerpt");
    await vi.waitFor(() => expect(onOpenSession).toHaveBeenCalledWith(
      "target-session",
      42,
      expect.objectContaining({ agentSessionId: "target-session" }),
    ));
  });

  it("shows an incomplete-search message instead of implying a completed zero-result search", () => {
    searchHarness.searchStatus = {
      search: { status: "partial", stage: "lexical", reason: "timeout" },
      query_expansion: { status: "partial", reason: "timeout", latency_ms: 0 },
    };

    ({ container, root } = renderSearchModal());
    const input = document.querySelector<HTMLInputElement>("input[type='text']");
    if (!input) throw new Error("SearchModal 검색 입력창이 없습니다.");
    setTextInputValue(input, "needle");

    expect(document.body.textContent).toContain("검색을 완료하지 못했습니다. 다시 검색해 주세요.");
    expect(document.body.textContent).not.toContain("검색 결과가 없습니다");
  });

  it("keeps lexical session results clickable while expanded search is pending", () => {
    searchHarness.expansionPending = true;
    searchHarness.sessionResults = [{
      session_id: "lexical-session",
      title: "Lexical hit",
      excerpt: "First response",
      updated_at: null,
      task_id: null,
      task_title: null,
      parent_session_id: null,
      best_match: { event_id: 12, match_source: "session_title", excerpt: "First response" },
      evidence: [],
      session_url: "/?session=lexical-session",
    }];
    const onOpenSession = vi.fn().mockResolvedValue(true);
    ({ container, root } = renderSearchModal({ onOpenSession }));

    expect(document.body.textContent).toContain("추가 검색 중…");
    clickResult("First response");
    expect(onOpenSession).toHaveBeenCalledWith("lexical-session", 12, undefined);
  });

  it("retains lexical rows and reports only the failed follow-up", () => {
    searchHarness.expansionFailed = true;
    searchHarness.sessionResults = [{
      session_id: "lexical-session",
      title: "Lexical hit",
      excerpt: "First response",
      updated_at: null,
      task_id: null,
      task_title: null,
      parent_session_id: null,
      best_match: { event_id: null, match_source: "session_title", excerpt: "First response" },
      evidence: [],
      session_url: "/?session=lexical-session",
    }];
    ({ container, root } = renderSearchModal());

    expect(document.body.textContent).toContain("추가 검색을 마치지 못했습니다");
    expect(document.body.textContent).toContain("Lexical hit");
    expect(document.body.querySelectorAll('[data-testid="session-search-result"]')).toHaveLength(1);
  });

  it("query expansion 부분 실패도 완료된 0건으로 표시하지 않는다", () => {
    searchHarness.searchStatus = {
      query_expansion: { status: "partial", reason: "configuration", latency_ms: 0 },
    };

    ({ container, root } = renderSearchModal());
    const input = document.querySelector<HTMLInputElement>("input[type='text']");
    if (!input) throw new Error("SearchModal 검색 입력창이 없습니다.");
    setTextInputValue(input, "needle");

    expect(document.body.textContent).toContain("검색을 완료하지 못했습니다. 다시 검색해 주세요.");
    expect(document.body.textContent).not.toContain("검색 결과가 없습니다");
  });

  it("keeps the search open when the host refuses to open a session result", async () => {
    const onOpenChange = vi.fn();
    const onOpenSession = vi.fn().mockResolvedValue(false);
    searchHarness.sessionResults = [{
      session_id: "missing-session",
      title: "Missing session",
      excerpt: "Cannot be opened",
      updated_at: null,
      task_id: null,
      task_title: null,
      parent_session_id: null,
      best_match: { event_id: null, match_source: "session_title", excerpt: "Cannot be opened" },
      evidence: [],
      session_url: "/?session=missing-session",
    }];

    ({ container, root } = renderSearchModal({ onOpenChange, onOpenSession }));
    clickResult("Cannot be opened");
    await vi.waitFor(() => expect(onOpenSession).toHaveBeenCalledTimes(1));

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("opens project and task title results through the existing dashboard store", () => {
    searchHarness.navigationResults = [
      {
        kind: "folder",
        id: "project-folder",
        title: "Needle project",
        folder_id: "project-folder",
        project_page_id: "project-page",
      },
    ];
    ({ container, root } = renderSearchModal());

    clickResult("Needle project");
    expect(useDashboardStore.getState().selectedFolderId).toBe("project-folder");

    flushSync(() => root?.unmount());
    root = undefined;
    container?.remove();
    searchHarness.navigationResults = [
      {
        kind: "task",
        id: "task-a",
        title: "Needle task",
        folder_id: "project-folder",
        project_page_id: "project-page",
        board_item_id: "board-item-a",
        task_page_id: "task-page-a",
      },
    ];
    ({ container, root } = renderSearchModal());

    clickResult("Needle task");
    expect(useDashboardStore.getState().activeBoardContainer).toEqual({
      kind: "task",
      id: "task-a",
    });
  });

  it("removes the human tool filter and gives every leading result badge one width", () => {
    searchHarness.navigationResults = [
      {
        kind: "folder",
        id: "project-folder",
        title: "Aligned project",
        folder_id: "project-folder",
        project_page_id: "project-page",
      },
      {
        kind: "task",
        id: "task-a",
        title: "Aligned task",
        folder_id: "project-folder",
        project_page_id: "project-page",
        board_item_id: "board-item-a",
        task_page_id: "task-page-a",
      },
    ];
    searchHarness.results = [
      {
        session_id: "target-session",
        event_id: 42,
        score: 1,
        preview: "Aligned message",
        event_type: "assistant_message",
        match_source: "message",
      },
    ];

    ({ container, root } = renderSearchModal());

    expect(document.body.textContent).not.toContain("툴 사용");
    for (const label of ["프로젝트", "업무", "Assistant"]) {
      const badge = Array.from(document.body.querySelectorAll("span"))
        .find((span) => span.textContent === label);
      expect(badge?.className).toContain("w-20");
      expect(badge?.className).toContain("justify-center");
    }
  });

  it("shows three derived-text scope toggles off by default", () => {
    ({ container, root } = renderSearchModal());

    for (const label of ["턴 요약", "하이라이트", "줄거리"]) {
      const labelElement = Array.from(document.body.querySelectorAll("label"))
        .find((candidate) => candidate.textContent?.includes(label));
      const input = labelElement?.querySelector<HTMLInputElement>("input");
      expect(input?.checked).toBe(false);
    }
  });

  it("keeps enabled derived-text scopes while the search query changes", async () => {
    ({ container, root } = renderSearchModal());
    const queryInput = document.body.querySelector<HTMLInputElement>(
      'input[type="text"]',
    );
    const storyLabel = Array.from(document.body.querySelectorAll("label"))
      .find((candidate) => candidate.textContent?.includes("줄거리"));
    const storyInput = storyLabel?.querySelector<HTMLInputElement>("input");
    expect(queryInput).not.toBeNull();
    expect(storyInput).not.toBeNull();

    setTextInputValue(queryInput!, "first query");
    flushSync(() => storyInput!.click());

    await vi.waitFor(() => {
      expect(searchHarness.search).toHaveBeenCalledWith(
        "first query",
        expect.objectContaining({
          includeTurnSummaries: false,
          includeHighlight: false,
          includeStory: true,
        }),
      );
    });

    setTextInputValue(queryInput!, "second query");
    expect(storyInput?.checked).toBe(true);
  });

  it("marks derived-text matches with source badges and a secondary tone", () => {
    searchHarness.results = [
      {
        session_id: "message-session",
        event_id: 11,
        score: 1,
        preview: "Message preview",
        event_type: "assistant_message",
        match_source: "message",
      },
      {
        session_id: "summary-session",
        event_id: 12,
        score: 1,
        preview: "Summary preview",
        event_type: "turn_summary",
        match_source: "turn_summary",
      },
      {
        session_id: "highlight-session",
        event_id: 13,
        score: 1,
        preview: "Highlight preview",
        event_type: "session_highlight",
        match_source: "highlight",
      },
      {
        session_id: "story-session",
        event_id: 14,
        score: 1,
        preview: "Story preview",
        event_type: "session_story",
        match_source: "story",
      },
    ];

    ({ container, root } = renderSearchModal());

    expect(document.body.textContent).toContain("Assistant");
    expect(document.body.textContent).toContain("턴 요약");
    expect(document.body.textContent).toContain("하이라이트");
    expect(document.body.textContent).toContain("줄거리");

    const messageRow = document.body.querySelector('[data-match-source="message"]');
    const summaryRow = document.body.querySelector('[data-match-source="turn_summary"]');
    const highlightRow = document.body.querySelector('[data-match-source="highlight"]');
    const storyRow = document.body.querySelector('[data-match-source="story"]');
    expect(messageRow?.querySelector("p")?.className).toContain("text-foreground");
    for (const row of [summaryRow, highlightRow, storyRow]) {
      expect(row?.querySelector("p")?.className).toContain(
        "text-muted-foreground",
      );
    }
  });

  it("anchors turn-summary matches and opens story matches in the existing panel", async () => {
    const onOpenSession = vi.fn().mockResolvedValue(true);
    const storyTrigger = document.createElement("button");
    storyTrigger.dataset.testid = "session-story-trigger";
    storyTrigger.setAttribute("aria-expanded", "false");
    const storyTriggerClick = vi.fn();
    storyTrigger.addEventListener("click", storyTriggerClick);
    document.body.appendChild(storyTrigger);
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    );

    searchHarness.results = [
      {
        session_id: "summary-session",
        event_id: 21,
        score: 1,
        preview: "Summary anchor preview",
        event_type: "turn_summary",
        match_source: "turn_summary",
      },
      {
        session_id: "story-session",
        event_id: 22,
        score: 1,
        preview: "Story panel preview",
        event_type: "session_story",
        match_source: "story",
      },
    ];

    ({ container, root } = renderSearchModal({ onOpenSession }));

    clickResult("Summary anchor preview");
    expect(onOpenSession).toHaveBeenCalledWith(
      "summary-session",
      21,
      undefined,
    );

    clickResult("Story panel preview");
    await vi.waitFor(() => {
      expect(onOpenSession).toHaveBeenCalledWith(
        "story-session",
        null,
        undefined,
      );
      expect(storyTriggerClick).toHaveBeenCalledTimes(1);
    });
  });
});
