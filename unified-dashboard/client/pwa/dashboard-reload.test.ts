/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { createDashboardReloadCoordinator, registerDashboardReader } from "./dashboard-reload";
describe("one reload decision", () => {
  it("explains that an open reader delays the automatic update", async () => {
    const unregister = registerDashboardReader();
    try {
      const owner = createDashboardReloadCoordinator({ document, reload: vi.fn(), hasPendingEdits: () => false, flushPendingEdits: async () => true });
      expect(await owner.request()).toBe(false);
      const banner = document.querySelector<HTMLElement>('[data-sw-update-banner]')!;
      expect(banner.querySelector("span")?.textContent).toBe("새 버전이 나왔습니다");
      expect([banner.style.right, banner.style.bottom, banner.style.background, banner.style.padding]).toEqual(["16px", "16px", "rgb(23, 23, 23)", "12px 14px"]);
    } finally { unregister(); document.body.replaceChildren(); }
  });
  it("keeps the existing appearance and copy for a pending attachment without a reader", async () => {
    const owner = createDashboardReloadCoordinator({ document, reload: vi.fn(), hasPendingEdits: () => true, hasAttachments: () => true, flushPendingEdits: async () => false });
    try {
      expect(await owner.request()).toBe(false);
      const banner = document.querySelector<HTMLElement>('[data-sw-update-banner]')!;
      expect(banner.textContent).toContain("작성 중인 내용을 확인한 뒤 새로고침합니다");
      expect([banner.style.right, banner.style.bottom, banner.style.background, banner.style.padding]).toEqual(["16px", "16px", "rgb(23, 23, 23)", "12px 14px"]);
    } finally { document.body.replaceChildren(); }
  });
  it("reserves space on an overlapping popup and clears it when the reader closes", async () => {
    const popup = document.createElement("div");
    document.body.append(popup);
    vi.spyOn(popup, "getBoundingClientRect").mockReturnValue({ left: 600, right: 1000, top: 200, bottom: 740 } as DOMRect);
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 800, right: 1008, top: 700, bottom: 752, height: 52 } as DOMRect);
    const unregister = registerDashboardReader(() => ({ popup }));
    try {
      const owner = createDashboardReloadCoordinator({ document, reload: vi.fn(), hasPendingEdits: () => false, flushPendingEdits: async () => true });
      expect(await owner.request()).toBe(false);
      const banner = document.querySelector<HTMLElement>('[data-sw-update-banner]')!;
      expect(banner.style.bottom).toBe("16px");
      expect(popup.style.getPropertyValue("--viewer-bottom-clearance")).toBe("84px");
      unregister();
      expect(popup.style.getPropertyValue("--viewer-bottom-clearance")).toBe("");
    } finally { unregister(); bounds.mockRestore(); document.body.replaceChildren(); }
  });
  it("leaves a nonoverlapping popup unchanged and clears clearance when the banner disappears", async () => {
    const popup = document.createElement("div");
    document.body.append(popup);
    const popupBounds = vi.spyOn(popup, "getBoundingClientRect").mockReturnValue({ left: 100, right: 400, top: 200, bottom: 600 } as DOMRect);
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 800, right: 1008, top: 700, bottom: 752, height: 52 } as DOMRect);
    const unregister = registerDashboardReader(() => ({ popup }));
    const owner = createDashboardReloadCoordinator({ document, reload: vi.fn(), hasPendingEdits: () => false, flushPendingEdits: async () => true });
    try {
      expect(await owner.request()).toBe(false);
      expect(popup.style.getPropertyValue("--viewer-bottom-clearance")).toBe("");
      popupBounds.mockReturnValue({ left: 600, right: 1000, top: 200, bottom: 740 } as DOMRect);
      window.dispatchEvent(new Event("resize"));
      expect(popup.style.getPropertyValue("--viewer-bottom-clearance")).toBe("84px");
      document.querySelector<HTMLButtonElement>('[data-sw-update-action]')!.click();
      await vi.waitFor(() => expect(popup.style.getPropertyValue("--viewer-bottom-clearance")).toBe(""));
    } finally { unregister(); bounds.mockRestore(); document.body.replaceChildren(); }
  });
  it("keeps the upload and service worker messages when a reader is open", async () => {
    const unregister = registerDashboardReader();
    try {
      const env = { document, reload: vi.fn(), hasPendingEdits: () => true, hasAttachments: () => true, flushPendingEdits: async () => false };
      expect(await createDashboardReloadCoordinator(env).request()).toBe(false);
      expect(document.querySelector('[data-sw-update-banner]')?.textContent).toContain("작성 중인 내용을 확인한 뒤 새로고침합니다");
      document.body.replaceChildren();
      expect(await createDashboardReloadCoordinator({ ...env, hasPendingEdits: () => false, hasAttachments: () => false }).request(undefined, false)).toBe(false);
      expect(document.querySelector('[data-sw-update-banner]')?.textContent).toContain("작성 중인 내용을 확인한 뒤 새로고침합니다");
    } finally { unregister(); document.body.replaceChildren(); }
  });
  it("reserves space when a reader opens after the banner", async () => {
    const owner = createDashboardReloadCoordinator({ document, reload: vi.fn(), hasPendingEdits: () => true, hasAttachments: () => true, flushPendingEdits: async () => false });
    const popup = document.createElement("div");
    document.body.append(popup);
    vi.spyOn(popup, "getBoundingClientRect").mockReturnValue({ left: 600, right: 1000, top: 200, bottom: 740 } as DOMRect);
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 800, right: 1008, top: 700, bottom: 752, height: 52 } as DOMRect);
    expect(await owner.request()).toBe(false);
    const banner = document.querySelector<HTMLElement>('[data-sw-update-banner]')!;
    const unregister = registerDashboardReader(() => ({ popup }));
    try {
      expect(banner.style.bottom).toBe("16px");
      expect(popup.style.getPropertyValue("--viewer-bottom-clearance")).toBe("84px");
      expect(banner.textContent).toContain("작성 중인 내용을 확인한 뒤 새로고침합니다");
    } finally { unregister(); bounds.mockRestore(); document.body.replaceChildren(); }
  });
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
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    } finally { unregister(); document.body.replaceChildren(); }
    reload.mockClear();
    expect(await createDashboardReloadCoordinator(env).request()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
  it("defers an automatic reload if a document opens while edits are flushing", async () => {
    const reload = vi.fn();
    let finishFlush!: (flushed: boolean) => void;
    const owner = createDashboardReloadCoordinator({
      document,
      reload,
      hasPendingEdits: () => true,
      flushPendingEdits: () => new Promise<boolean>((resolve) => { finishFlush = resolve; }),
    });
    const request = owner.request();
    const unregister = registerDashboardReader();
    try {
      finishFlush(true);
      expect(await request).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(document.querySelector('[data-sw-update-banner]')).not.toBeNull();
    } finally { unregister(); document.body.replaceChildren(); }
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
