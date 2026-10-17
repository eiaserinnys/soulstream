/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseChatAttachmentsResult } from "./useChatAttachments";
import { useChatAttachments } from "./useChatAttachments";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("useChatAttachments", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: UseChatAttachmentsResult;
  const requests: Array<{ url: string; options: RequestInit; result: ReturnType<typeof deferred> }> = [];

  function Harness({ sessionId, eventId, enabled = true }: { sessionId: string; eventId: number; enabled?: boolean }) {
    latest = useChatAttachments({ sessionId, eventId, enabled });
    return null;
  }

  const render = async (sessionId: string, eventId = 42, enabled = true) => {
    await act(() => root.render(createElement(Harness, { sessionId, eventId, enabled })));
  };

  beforeEach(() => {
    container = document.createElement("div");
    root = createRoot(container);
    requests.length = 0;
    vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => {
      const result = deferred();
      requests.push({ url, options, result });
      return result.promise;
    }));
  });

  afterEach(async () => {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
    container.remove();
  });

  it("loads one event projection and exposes projected items", async () => {
    await render("session-a");
    expect(latest.loading).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/api/sessions/session-a/events/42/attachments");
    expect(requests[0]?.options.credentials).toBe("same-origin");

    await act(async () => requests[0]?.result.resolve(jsonResponse({ event_id: 42, items: [] })));
    expect(latest).toMatchObject({ items: [], loading: false, error: null });
  });

  it("aborts the previous session projection and ignores its late response", async () => {
    await render("session-a");
    const previousSignal = requests[0]?.options.signal as AbortSignal;
    await render("session-b");

    expect(previousSignal.aborted).toBe(true);
    expect(requests[1]?.url).toBe("/api/sessions/session-b/events/42/attachments");
    await act(async () => requests[1]?.result.resolve(jsonResponse({ event_id: 42, items: [] })));
    await act(async () => requests[0]?.result.resolve(jsonResponse({ event_id: 42, items: [] })));
    expect(latest).toMatchObject({ items: [], loading: false, error: null });
    expect(requests).toHaveLength(2);
  });

  it("stays idle when disabled and loads after it becomes enabled", async () => {
    await render("session-a", 42, false);
    expect(latest).toMatchObject({ items: [], loading: false, error: null });
    expect(requests).toHaveLength(0);

    await render("session-a", 42, true);
    expect(requests).toHaveLength(1);
  });

  it("does not retry automatically and reload starts one request", async () => {
    await render("session-a");
    await act(async () => requests[0]?.result.resolve(jsonResponse({}, 503)));
    expect(latest.loading).toBe(false);
    expect(latest.error).toBeTruthy();
    expect(requests).toHaveLength(1);

    await act(() => latest.reload());
    expect(requests).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 422, 429, 500, 503, 599])("exposes retryability from HTTP %s and clears it on reload", async status => {
    await render("session-a");
    await act(async () => requests[0]?.result.resolve(jsonResponse({}, status)));
    expect(latest.retryable).toBe(status >= 500);
    if (status === 400 || status === 422) expect(latest.error).toBe("첨부 정보를 확인할 수 없습니다.");
    await act(() => latest.reload());
    expect(latest.retryable).toBe(false);
  });

  it("allows a network failure to be retried", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await render("session-a");
    expect(latest.retryable).toBe(true);
  });

  it("does not classify an invalid projection as a network failure", async () => {
    await render("session-a");
    await act(async () => requests[0]?.result.resolve(jsonResponse({})));
    expect(latest.retryable).toBe(false);
  });
});
