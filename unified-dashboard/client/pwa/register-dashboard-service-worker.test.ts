/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { registerDashboardServiceWorker } from "./register-dashboard-service-worker";

afterEach(() => {
  document.body.replaceChildren();
});

describe("registerDashboardServiceWorker", () => {
  it("bypasses HTTP cache and checks immediately, periodically, and on visibility return", async () => {
    const update = vi.fn(async () => undefined);
    const listeners = new Map<string, EventListener>();
    const serviceWorker = {
      register: vi.fn(async () => ({ update })),
      addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
      removeEventListener: vi.fn(),
    };
    const scheduled: Array<() => void> = [];
    const environment = {
      serviceWorker,
      document,
      reload: vi.fn(),
      setInterval: vi.fn((callback: () => void) => {
        scheduled.push(callback);
        return 1;
      }),
      clearInterval: vi.fn(),
      warn: vi.fn(),
      hasPendingEdits: vi.fn(() => false),
      flushPendingEdits: vi.fn(async () => true),
    };

    const cleanup = await registerDashboardServiceWorker(environment);

    expect(serviceWorker.register).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    expect(update).toHaveBeenCalledTimes(1);
    scheduled[0]!();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(3);
    const source = { state: "activated", postMessage: vi.fn() };
    listeners.get("message")!({
      data: { type: "SOULSTREAM_SW_ACTIVATED", token: "migration-ready" },
      source,
    } as unknown as Event);
    expect(source.postMessage).toHaveBeenCalledWith({
      type: "SOULSTREAM_SW_APPROVE_RELOAD",
      token: "migration-ready",
    });
    cleanup();
  });

  it("keeps periodic checks after the immediate update fails", async () => {
    const update = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const scheduled: Array<() => void> = [];
    const environment = {
      serviceWorker: {
        register: vi.fn(async () => ({ update })),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      document,
      reload: vi.fn(),
      setInterval: vi.fn((callback: () => void) => { scheduled.push(callback); return 1; }),
      clearInterval: vi.fn(),
      warn: vi.fn(),
      hasPendingEdits: vi.fn(() => false),
      flushPendingEdits: vi.fn(async () => true),
    };

    const cleanup = await registerDashboardServiceWorker(environment);
    await vi.waitFor(() => expect(environment.warn).toHaveBeenCalledWith(
      "Service worker update check failed",
      expect.any(Error),
    ));
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("announces activation negotiation support to active and newly installing workers", async () => {
    let onUpdateFound: EventListener | undefined;
    const active = { postMessage: vi.fn() };
    const installing = { postMessage: vi.fn() };
    const controller = { postMessage: vi.fn() };
    const registration = {
      update: vi.fn(async () => undefined),
      active,
      installing,
      addEventListener: vi.fn((_type: "updatefound", listener: EventListener) => {
        onUpdateFound = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const cleanup = await registerDashboardServiceWorker({
      serviceWorker: {
        register: vi.fn(async () => registration),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        controller,
      },
      document,
      reload: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      warn: vi.fn(),
      hasPendingEdits: vi.fn(() => false),
      flushPendingEdits: vi.fn(async () => true),
    });

    const capability = { type: "SOULSTREAM_SW_CAPABLE" };
    expect(active.postMessage).toHaveBeenCalledWith(capability);
    expect(installing.postMessage).toHaveBeenCalledWith(capability);
    expect(controller.postMessage).toHaveBeenCalledWith(capability);
    onUpdateFound!(new Event("updatefound"));
    expect(installing.postMessage).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("defers from controller pending state and approves only after flush", async () => {
    let messageListener: EventListener | undefined;
    const serviceWorker = {
      register: vi.fn(async () => ({ update: vi.fn(async () => undefined) })),
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === "message") messageListener = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const source = { state: "activated", postMessage: vi.fn() };
    const flushPendingEdits = vi.fn(async () => true);

    const cleanup = await registerDashboardServiceWorker({
      serviceWorker,
      document,
      reload: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      warn: vi.fn(),
      hasPendingEdits: vi.fn(() => true),
      flushPendingEdits,
    });
    messageListener!({
      data: { type: "SOULSTREAM_SW_ACTIVATED", token: "migration-1" },
      source,
    } as unknown as Event);

    expect(source.postMessage).toHaveBeenCalledWith({
      type: "SOULSTREAM_SW_DEFER_RELOAD",
      token: "migration-1",
    });
    const button = document.querySelector<HTMLButtonElement>("[data-sw-update-action]");
    expect(button?.textContent).toContain("새 버전 적용");
    button!.click();
    await vi.waitFor(() => expect(flushPendingEdits).toHaveBeenCalledTimes(1));
    expect(source.postMessage).toHaveBeenLastCalledWith({
      type: "SOULSTREAM_SW_APPROVE_RELOAD",
      token: "migration-1",
    });
    cleanup();
  });
  it("waits for worker activation before approving a page without edits", async () => {
    const harness = await updateHarness(false, true);
    harness.message();
    expect(harness.source.postMessage).not.toHaveBeenCalled();
    harness.activate();
    expect(harness.source.postMessage).toHaveBeenCalledWith({ type: "SOULSTREAM_SW_APPROVE_RELOAD", token: "ready" });
    harness.cleanup();
  });

  it("keeps defer and the draft protected when flushing fails", async () => {
    const harness = await updateHarness(true, false);
    harness.message();
    harness.activate();
    document.querySelector<HTMLButtonElement>("[data-sw-update-action]")!.click();
    await vi.waitFor(() => expect(harness.flush).toHaveBeenCalledTimes(1));
    expect(harness.source.postMessage.mock.calls).toEqual([[{ type: "SOULSTREAM_SW_DEFER_RELOAD", token: "ready" }]]);
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("[data-sw-update-action]")?.disabled).toBe(false));
    harness.cleanup();
  });

  it("waits for activation even when the user has already flushed successfully", async () => {
    const harness = await updateHarness(true, true);
    harness.message();
    document.querySelector<HTMLButtonElement>("[data-sw-update-action]")!.click();
    await vi.waitFor(() => expect(harness.flush).toHaveBeenCalledTimes(1));
    expect(harness.source.postMessage.mock.calls).toEqual([[{ type: "SOULSTREAM_SW_DEFER_RELOAD", token: "ready" }]]);
    harness.activate();
    expect(harness.source.postMessage).toHaveBeenLastCalledWith({ type: "SOULSTREAM_SW_APPROVE_RELOAD", token: "ready" });
    harness.cleanup();
  });

});


async function updateHarness(pending: boolean, flushResult: boolean) {
  let listener!: EventListener;
  const source = Object.assign(new EventTarget(), { state: "activating", postMessage: vi.fn() });
  const flush = vi.fn(async () => flushResult);
  const cleanup = await registerDashboardServiceWorker({
    serviceWorker: { register: vi.fn(async () => ({ update: vi.fn(async () => undefined) })),
      addEventListener: vi.fn((type: string, next: EventListener) => { if (type === "message") listener = next; }), removeEventListener: vi.fn() },
    document, reload: vi.fn(), setInterval: vi.fn(() => 1), clearInterval: vi.fn(), warn: vi.fn(),
    hasPendingEdits: () => pending, flushPendingEdits: flush,
  });
  return { source, flush, cleanup,
    message: () => listener({ data: { type: "SOULSTREAM_SW_ACTIVATED", token: "ready" }, source } as unknown as Event),
    activate: () => { source.state = "activated"; source.dispatchEvent(new Event("statechange")); },
  };
}
