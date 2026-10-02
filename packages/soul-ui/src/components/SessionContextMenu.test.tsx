/**
 * @vitest-environment jsdom
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionContextMenu } from "./SessionContextMenu";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

async function renderMenu(props: Partial<React.ComponentProps<typeof SessionContextMenu>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClose = vi.fn();

  await act(async () => {
    root.render(
      createElement(SessionContextMenu, {
        contextMenu: { x: 10, y: 20, sessionId: "session-a" },
        onClose,
        getSessionName: () => "Session A",
        resolveSessionIds: (sessionId: string) => [sessionId],
        ...props,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return { container, root, onClose };
}

function findMenuItem(text: string): HTMLElement {
  const item = Array.from(document.body.querySelectorAll<HTMLElement>("[data-slot='menu-item'], button"))
    .find((element) => element.textContent?.trim() === text
      || element.firstElementChild?.textContent?.trim() === text);
  if (!item) throw new Error(`Menu item not found: ${text}`);
  return item;
}

describe("SessionContextMenu", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      eligible: false,
      reason: "예약할 수 없습니다.",
      resets_at: null,
      schedule: null,
    })));
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
  });

  it("keeps the complete session action set visible when capabilities are unavailable", async () => {
    ({ container, root } = await renderMenu());
    for (const label of ["이 세션을 이어서 시작하기", "이름 변경", "다른 폴더로 이동", "삭제", "재개 예약 취소"]) {
      const item = findMenuItem(label);
      expect(item.getAttribute("aria-disabled") === "true" || item.hasAttribute("disabled")).toBe(true);
      expect(item.title).not.toBe("");
    }
  });

  it("shows continue-session action and calls the injected callback", async () => {
    const onContinueSession = vi.fn().mockResolvedValue(undefined);
    ({ container, root } = await renderMenu({
      onContinueSession,
      getContinueSessionDisabledReason: () => null,
    }));

    const item = findMenuItem("이 세션을 이어서 시작하기");

    await act(async () => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await Promise.resolve();

    expect(onContinueSession).toHaveBeenCalledWith("session-a");
  });

  it("keeps the continue-session action visible but disabled with a reason", async () => {
    ({ container, root } = await renderMenu({
      onContinueSession: vi.fn().mockResolvedValue(undefined),
      getContinueSessionDisabledReason: () => "에이전트 정보가 없어 이어서 시작할 수 없습니다.",
    }));

    const item = findMenuItem("이 세션을 이어서 시작하기");

    expect(item.getAttribute("aria-disabled") ?? item.getAttribute("data-disabled")).toBeTruthy();
    expect(item.getAttribute("title")).toBe("에이전트 정보가 없어 이어서 시작할 수 없습니다.");
  });

  it("shows continue-session failures instead of swallowing them", async () => {
    ({ container, root } = await renderMenu({
      onContinueSession: vi.fn().mockRejectedValue(new Error("node unavailable")),
      getContinueSessionDisabledReason: () => null,
    }));

    const item = findMenuItem("이 세션을 이어서 시작하기");

    await act(async () => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.textContent).toContain("세션 이어서 시작 실패");
    expect(document.body.textContent).toContain("node unavailable");
  });

  it("loads eligibility when opened and explains why the action is disabled", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      eligible: false,
      reason: "현재 세션이 사용량 제한으로 중단된 상태가 아닙니다.",
      resets_at: null,
      schedule: null,
    }) as Response);

    ({ container, root } = await renderMenu());

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-a/resume-after-limit");
    const item = findMenuItem("리밋이 풀릴 때 재개");
    expect(item.getAttribute("aria-disabled") ?? item.getAttribute("data-disabled")).toBeTruthy();
    expect(findMenuItem("리밋이 풀릴 때 재개").querySelector("[role='status']")?.textContent)
      .toContain("현재 세션이 사용량 제한으로 중단된 상태가 아닙니다.");
  });

  it("shows the local reservation time only after the schedule API succeeds", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        eligible: true,
        reason: null,
        resets_at: "2026-09-28T11:00:00.000Z",
        schedule: null,
      }) as Response)
      .mockResolvedValueOnce(jsonResponse({
        schedule_id: "resume-after-limit:session-a:32:0",
        run_at: "2026-09-28T11:00:00.000Z",
        status: "active",
        reused: false,
      }) as Response);

    ({ container, root } = await renderMenu());
    await act(async () => {
      findMenuItem("리밋이 풀릴 때 재개").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenNthCalledWith(2,
      "/api/sessions/session-a/resume-after-limit",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(findMenuItem("리밋이 풀릴 때 재개").querySelector("[role='status']")?.textContent).toMatch(/재개 예약$/);
  });

  it("uses the existing schedule cancel endpoint and reports its result", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        eligible: true,
        reason: null,
        resets_at: "2026-09-28T11:00:00.000Z",
        schedule: {
          schedule_id: "resume-after-limit:session-a:32:0",
          run_at: "2026-09-28T11:00:00.000Z",
          status: "active",
        },
      }) as Response)
      .mockResolvedValueOnce(jsonResponse({ deleted: true }) as Response);

    ({ container, root } = await renderMenu());
    await act(async () => {
      findMenuItem("재개 예약 취소").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/sessions/session-a/schedules/resume-after-limit%3Asession-a%3A32%3A0",
      { method: "DELETE" },
    );
    expect(findMenuItem("리밋이 풀릴 때 재개").querySelector("[role='status']")?.textContent)
      .toContain("재개 예약을 취소했습니다.");
  });
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
