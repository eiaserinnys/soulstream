/**
 * @vitest-environment jsdom
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStoryDisclosure } from "./SessionStoryDisclosure";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("SessionStoryDisclosure", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(SessionStoryDisclosure, { sessionId: "sess/1" }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stays collapsed without fetching until the user opens it", () => {
    expect(storyButton().getAttribute("aria-expanded")).toBe("false");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="session-story-panel"]')).toBeNull();
  });

  it("fetches lazily and renders highlight before the full chronological story", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      highlight: "하이라이트 문장",
      narrative: "[T1-T4] 접힌 줄거리",
      unfolded_turn_summaries: [{
        event_id: 50,
        turn_number: 5,
        content: "최근 턴 요약",
        turn_start_event_id: 45,
        final_response_event_id: 49,
        created_at: "2026-07-30T17:00:00.000Z",
      }],
      narrative_through_event_id: 44,
      fold_count: 1,
      updated_at: "2026-07-30T16:59:00.000Z",
    }));

    await act(async () => storyButton().click());

    await vi.waitFor(() => {
      expect(container.textContent).toContain("최근 턴 요약");
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/sess%2F1/story", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: expect.any(AbortSignal),
    });
    const text = container.textContent ?? "";
    expect(text.indexOf("하이라이트 문장")).toBeLessThan(text.indexOf("[T1-T4] 접힌 줄거리"));
    expect(text.indexOf("[T1-T4] 접힌 줄거리")).toBeLessThan(text.indexOf("최근 턴 요약"));
  });

  it("shows a compact empty-state notice and refetches on reopening", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      highlight: null,
      narrative: null,
      unfolded_turn_summaries: [],
      narrative_through_event_id: null,
      fold_count: 0,
      updated_at: null,
    }));

    await act(async () => storyButton().click());
    await vi.waitFor(() => {
      expect(container.textContent).toContain("아직 정리된 스토리가 없습니다.");
    });

    await act(async () => storyButton().click());
    await act(async () => storyButton().click());
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  function storyButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-story-trigger"]',
    );
    if (!button) throw new Error("story trigger not rendered");
    return button;
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
