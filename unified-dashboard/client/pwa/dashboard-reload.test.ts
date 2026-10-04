/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { createDashboardReloadCoordinator } from "./dashboard-reload";
describe("one reload decision", () => {
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
