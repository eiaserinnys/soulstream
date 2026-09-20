/** @vitest-environment jsdom */
/**
 * 실제 배선 통합 증거.
 *
 * 순수 `subscribeNavigationUiEvents` 단위 검사는 살아 있는 tracker 를 직접 넘기므로
 * 부팅 순서를 통과하지 못한다. 진짜 순서는
 *   Provider 마운트(수집기 NOOP) → 비동기 config 도착 → 수집 켜짐 → 구독
 * 이고, 이 파일은 그 순서를 그대로 밟아 최초 화면이 서버로 나가는지 본다.
 */
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDashboardStore } from "@seosoyoung/soul-ui";

import { UiEventsRuntime } from "./UiEventsRuntime";

type Batch = { installId: string; events: { type: string; target?: unknown; entry?: string }[] };

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let posted: Batch[] = [];

function configResponse(enabled: boolean) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      enabled,
      flushIntervalMs: 10_000,
      maxBatchSize: 20,
      maxQueueSize: 500,
      schemaVersion: "soulstream.ui_event.v1",
    }),
  };
}

function installFetch(
  options: { enabled?: boolean; configOk?: boolean; failConfigAfterFirst?: boolean } = {},
) {
  let configCalls = 0;
  const fetchMock = vi.fn(async (url: unknown, init?: { body?: string }) => {
    const href = String(url);
    if (href.includes("/api/ui-events/config")) {
      configCalls += 1;
      if (options.configOk === false) return { ok: false, status: 500, json: async () => ({}) };
      if (options.failConfigAfterFirst === true && configCalls > 1) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return configResponse(options.enabled ?? true);
    }
    if (href.includes("/api/ui-events")) {
      posted.push(JSON.parse(init?.body ?? "{}") as Batch);
      return { ok: true, status: 200, json: async () => ({ accepted: 1, duplicates: 0, rejected: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** AuthProvider 전체를 세우지 않고 신원만 고정한다. */
vi.mock("@seosoyoung/soul-ui/providers", () => ({
  useAuth: () => ({ user: { email: "owner@example.com" } }),
}));

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}

/**
 * 배치는 10초 주기나 20건에서 나간다. 통합 증거는 "큐에 들어갔다"가 아니라
 * "서버로 나갔다"여야 하므로 실제 flush 타이머를 돌려 보낸다.
 */
async function drainFlushTimer(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
  await settle();
}

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => {
    root!.render(createElement(UiEventsRuntime, { children: null }));
  });
}

describe("ui events runtime wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    posted = [];
    localStorage.clear();
    useDashboardStore.setState({ viewMode: "feed", activeSessionKey: null });
  });

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    root = undefined;
    container?.remove();
    container = undefined;
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("records the screen that was already open, through the real boot order", async () => {
    // 부팅 시점에 이미 세션이 열려 있다.
    useDashboardStore.setState({ viewMode: "folder", activeSessionKey: "session-boot" });
    installFetch({ enabled: true });

    await mount();
    await settle();
    await drainFlushTimer();

    const events = posted.flatMap((batch) => batch.events);
    const initial = events.find((event) => event.type === "view_open");
    expect(initial, "최초 화면 view_open 이 서버로 나가야 한다").toBeDefined();
    expect(initial?.target).toEqual({ kind: "session", id: "session-boot" });
    expect(initial?.entry).toBe("url");
  });

  it("keeps recording moves made after the collector came up", async () => {
    installFetch({ enabled: true });
    await mount();
    await settle();

    await act(async () => {
      useDashboardStore.getState().setActiveSession("session-next");
    });
    await drainFlushTimer();

    const targets = posted
      .flatMap((batch) => batch.events)
      .filter((event) => event.type === "view_open")
      .map((event) => event.target);
    expect(targets).toContainEqual({ kind: "session", id: "session-next" });
  });

  it("sends nothing at all while the server says collection is off", async () => {
    useDashboardStore.setState({ activeSessionKey: "session-boot" });
    installFetch({ enabled: false });

    await mount();
    await settle();
    await act(async () => {
      useDashboardStore.getState().setActiveSession("session-next");
    });
    await drainFlushTimer();

    expect(posted).toHaveLength(0);
  });

  it("sends nothing when the config call fails, instead of assuming permission", async () => {
    useDashboardStore.setState({ activeSessionKey: "session-boot" });
    installFetch({ configOk: false });

    await mount();
    await drainFlushTimer();

    expect(posted).toHaveLength(0);
  });

  it("stops collecting when a later config check fails, instead of staying on", async () => {
    // 한 번 켜졌다고 계속 켜 두면 '조회 실패 시 off' 계약과 어긋난다.
    // 이 경로만이 fail-closed 수리를 실제로 구분한다 — 처음부터 꺼져 있으면
    // 고치기 전후가 똑같이 아무것도 보내지 않기 때문이다.
    useDashboardStore.setState({ activeSessionKey: "session-boot" });
    installFetch({ enabled: true, failConfigAfterFirst: true });

    await mount();
    await settle();
    await drainFlushTimer();
    const postedWhileOn = posted.length;
    expect(postedWhileOn).toBeGreaterThan(0);

    // 탭으로 돌아오면 설정을 다시 읽고, 이번에는 실패한다.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();

    posted = [];
    await act(async () => {
      useDashboardStore.getState().setActiveSession("session-after-failure");
    });
    await drainFlushTimer();

    expect(posted).toHaveLength(0);
  });

  it("subscribes once, so a re-render does not double the initial record", async () => {
    useDashboardStore.setState({ activeSessionKey: "session-boot" });
    installFetch({ enabled: true });

    await mount();
    await settle();
    await act(async () => {
      root!.render(createElement(UiEventsRuntime, { children: null }));
    });
    await drainFlushTimer();

    const initials = posted
      .flatMap((batch) => batch.events)
      .filter((event) => event.type === "view_open" && event.entry === "url");
    expect(initials).toHaveLength(1);
  });
});
