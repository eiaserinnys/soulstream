/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useRunbookStore, type RunbookSnapshot } from "../stores/runbook-store";
import { RunbookCard } from "./RunbookCard";

function sampleSnapshot(): RunbookSnapshot {
  return {
    runbook: {
      id: "rb-1",
      board_item_id: "runbook:rb-1",
      folder_id: "f1",
      title: "Deploy Runbook",
      archived: false,
      version: 2,
      created_session_id: null,
      created_event_id: null,
      created_at: "2026-06-16T00:00:00+00:00",
      updated_at: "2026-06-16T00:00:00+00:00",
    },
    sections: [
      {
        id: "sec-1",
        runbook_id: "rb-1",
        position_key: "a",
        title: "Release",
        archived: false,
        version: 1,
        assignee_kind: "human",
        assignee_agent_id: null,
        assignee_session_id: null,
        assignee_user_id: "operator@example.com",
        created_session_id: null,
        created_event_id: null,
        updated_session_id: null,
        updated_event_id: null,
        created_at: "2026-06-16T00:00:00+00:00",
        updated_at: "2026-06-16T00:00:00+00:00",
      },
    ],
    items: [
      {
        id: "item-1",
        section_id: "sec-1",
        position_key: "a",
        title: "Run migration check",
        how_to: "Run `pnpm test` before handoff.",
        status: "pending",
        archived: false,
        version: 1,
        assignee_kind: null,
        assignee_agent_id: null,
        assignee_session_id: null,
        assignee_user_id: null,
        created_session_id: null,
        created_event_id: null,
        updated_session_id: null,
        updated_event_id: null,
        completed_kind: null,
        completed_session_id: null,
        completed_event_id: null,
        completed_user_id: null,
        completed_at: null,
        created_at: "2026-06-16T00:00:00+00:00",
        updated_at: "2026-06-16T00:00:00+00:00",
      },
      {
        id: "item-2",
        section_id: "sec-1",
        position_key: "b",
        title: "Agent finished",
        how_to: "Done docs should stay folded.",
        status: "completed",
        archived: false,
        version: 1,
        assignee_kind: "agent",
        assignee_agent_id: "roselin",
        assignee_session_id: null,
        assignee_user_id: null,
        created_session_id: null,
        created_event_id: null,
        updated_session_id: null,
        updated_event_id: null,
        completed_kind: "agent",
        completed_session_id: "sess-1",
        completed_event_id: 10,
        completed_user_id: null,
        completed_at: "2026-06-16T00:01:00+00:00",
        created_at: "2026-06-16T00:00:00+00:00",
        updated_at: "2026-06-16T00:00:00+00:00",
      },
      {
        id: "item-3",
        section_id: "sec-1",
        position_key: "c",
        title: "Cancelled path",
        how_to: "Cancelled docs should stay folded.",
        status: "cancelled",
        archived: false,
        version: 1,
        assignee_kind: "session",
        assignee_agent_id: null,
        assignee_session_id: "sess-2",
        assignee_user_id: null,
        created_session_id: null,
        created_event_id: null,
        updated_session_id: null,
        updated_event_id: null,
        completed_kind: null,
        completed_session_id: null,
        completed_event_id: null,
        completed_user_id: null,
        completed_at: null,
        created_at: "2026-06-16T00:00:00+00:00",
        updated_at: "2026-06-16T00:00:00+00:00",
      },
      {
        id: "item-4",
        section_id: "sec-1",
        position_key: "d",
        title: "Archived item",
        how_to: "",
        status: "pending",
        archived: true,
        version: 1,
        assignee_kind: null,
        assignee_agent_id: null,
        assignee_session_id: null,
        assignee_user_id: null,
        created_session_id: null,
        created_event_id: null,
        updated_session_id: null,
        updated_event_id: null,
        completed_kind: null,
        completed_session_id: null,
        completed_event_id: null,
        completed_user_id: null,
        completed_at: null,
        created_at: "2026-06-16T00:00:00+00:00",
        updated_at: "2026-06-16T00:00:00+00:00",
      },
    ],
  };
}

describe("RunbookCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
    useRunbookStore.getState().reset();
  });

  it("renders progress, human turn highlight, disabled human write state, and folded terminal how_to", () => {
    useRunbookStore.setState({
      byId: {
        "rb-1": {
          snapshot: sampleSnapshot(),
          status: "ready",
          error: null,
          isRefreshing: false,
        },
      },
    });

    flushSync(() => {
      root.render(createElement(RunbookCard, {
        runbookId: "rb-1",
        fallbackTitle: "Fallback",
      }));
    });

    const html = container.innerHTML;

    expect(html).toContain("Deploy Runbook");
    expect(html).toContain("1/2");
    expect(html).toContain("내 차례");
    expect(html).toContain("PR-3b 대기");
    expect(html).toContain("Run migration check");
    expect(html).toContain("Run <code");
    expect(html).toContain("Cancelled path");
    expect(html).toContain("line-through");
    expect(html).not.toContain("Done docs should stay folded");
    expect(html).not.toContain("Cancelled docs should stay folded");
    expect(html).not.toContain("Archived item");
  });
});
