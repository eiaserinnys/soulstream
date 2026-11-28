/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { createDashboardReloadCoordinator, registerDashboardReader } from "./dashboard-reload";
describe("one reload decision", () => {
  it("defers reload while a document is registered and reloads directly when none is open", async () => {
    const reload = vi.fn();
    const env = { document, reload, hasPendingEdits: () => false, flushPendingEdits: async () => true };
    const unregister = registerDashboardReader();
    try {
      const owner = createDashboardReloadCoordinator(env);
      expect(await owner.request()).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(document.querySelector('[data-sw-update-banner]')).not.toBeNull();
      document.querySelector<HTMLButtonElement>('[data-sw-update-action]')!.click();
      await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-sw-update-action]')!.disabled).toBe(false));
      expect(reload).not.toHaveBeenCalled();
      unregister();
      document.querySelector<HTMLButtonElement>('[data-sw-update-action]')!.click();
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    } finally { unregister(); document.body.replaceChildren(); }
    reload.mockClear();
    expect(await createDashboardReloadCoordinator(env).request()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
  it("flushes edits before reload and coalesces competing SW/build decisions", async () => {
    const reload = vi.fn(),
      flush = vi.fn(async () => true);
    const owner = createDashboardReloadCoordinator({
      document,
      reload,
      hasPendingEdits: () => true,
      hasAttachments: () => false,
      flushPendingEdits: flush,
    });
    expect(await owner.request()).toBe(true);
    await owner.request(reload);
    expect(flush).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });
  it("defers retained attachments to the banner without trapping the page", async () => {
    let pending = true;
    const reload = vi.fn();
    const owner = createDashboardReloadCoordinator({
      document,
      reload,
      hasPendingEdits: () => pending,
      hasAttachments: () => pending,
      flushPendingEdits: async () => !pending,
    });
    expect(await owner.request()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    pending = false;
    document
      .querySelector<HTMLButtonElement>("[data-sw-update-action]")!
      .click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    document.body.replaceChildren();
  });
});
