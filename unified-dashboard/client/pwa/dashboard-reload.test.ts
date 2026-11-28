/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { createDashboardReloadCoordinator, registerDashboardReader } from "./dashboard-reload";
describe("one reload decision", () => {
  it("explains that an open reader delays the automatic update", async () => {
    const unregister = registerDashboardReader();
    try {
      const owner = createDashboardReloadCoordinator({ document, reload: vi.fn(), hasPendingEdits: () => false, flushPendingEdits: async () => true });
      expect(await owner.request()).toBe(false);
      expect(document.querySelector('[data-sw-update-banner]')?.textContent).toContain("새 버전이 나왔습니다. 문서를 읽는 동안은 저절로 새로 고치지 않습니다");
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
  it("moves above a registered footer and restores its position when the reader closes", async () => {
    const footer = document.createElement("div");
    vi.spyOn(footer, "getBoundingClientRect").mockReturnValue({ top: 600 } as DOMRect);
    const unregister = registerDashboardReader(() => ({ footer }));
    try {
      const owner = createDashboardReloadCoordinator({ document, reload: vi.fn(), hasPendingEdits: () => false, flushPendingEdits: async () => true });
      expect(await owner.request()).toBe(false);
      const banner = document.querySelector<HTMLElement>('[data-sw-update-banner]')!;
      expect(banner.style.bottom).toBe(`${window.innerHeight - 600 + 16}px`);
      vi.mocked(footer.getBoundingClientRect).mockReturnValue({ top: 500 } as DOMRect);
      window.dispatchEvent(new Event("resize"));
      expect(banner.style.bottom).toBe(`${window.innerHeight - 500 + 16}px`);
      unregister();
      expect(banner.style.bottom).toBe("16px");
    } finally { unregister(); document.body.replaceChildren(); }
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
  it("moves an existing banner when a reader opens", async () => {
    const owner = createDashboardReloadCoordinator({ document, reload: vi.fn(), hasPendingEdits: () => true, hasAttachments: () => true, flushPendingEdits: async () => false });
    const footer = document.createElement("div");
    vi.spyOn(footer, "getBoundingClientRect").mockReturnValue({ top: 600 } as DOMRect);
    expect(await owner.request()).toBe(false);
    const banner = document.querySelector<HTMLElement>('[data-sw-update-banner]')!;
    const unregister = registerDashboardReader(() => ({ footer }));
    try {
      expect(banner.style.bottom).toBe(`${window.innerHeight - 600 + 16}px`);
      expect(banner.textContent).toContain("작성 중인 내용을 확인한 뒤 새로고침합니다");
    } finally { unregister(); document.body.replaceChildren(); }
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
