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

const searchHarness = vi.hoisted(() => ({
  results: [] as Array<{
    session_id: string;
    event_id: number;
    score: number;
    preview: string;
    event_type: string;
  }>,
  search: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("../hooks/useSessionSearch", () => ({
  useSessionSearch: () => ({
    results: searchHarness.results,
    loading: false,
    error: null,
    search: searchHarness.search,
    clear: searchHarness.clear,
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
    focusEventId: number,
    session?: SessionSummary,
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

describe("SearchModal", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });
    useDashboardStore.getState().reset();
    searchHarness.results = [];
    searchHarness.search.mockReset();
    searchHarness.clear.mockReset();
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
        event_type: "text_delta",
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
});
