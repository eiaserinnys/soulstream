import { adminTranslation, type AdminTranslate } from "../components/config/admin-translation";
import {
  hasPendingDashboardAttachments,
  hasPendingDashboardMutations,
  waitForDashboardMutationsToFlush,
} from "@seosoyoung/soul-ui/pending-mutation-registry";

type ReaderElements = { footer?: HTMLElement | null; content?: HTMLElement | null };
const openReaders = new Set<() => ReaderElements>();
const bannerUpdates = new Set<() => void>();
function updateBanners() {
  for (const update of bannerUpdates) update();
}
export function registerDashboardReader(getElements: () => ReaderElements = () => ({})): () => void {
  const reader = () => getElements();
  openReaders.add(reader);
  updateBanners();
  return () => { openReaders.delete(reader); updateBanners(); };
}

export interface ReloadEnvironment {
  document: Document;
  reload(): void;
  hasPendingEdits(): boolean;
  flushPendingEdits(): Promise<boolean>;
  hasAttachments?(): boolean;
  translate?(): AdminTranslate;
}
export function createDashboardReloadCoordinator(
  environment: ReloadEnvironment,
) {
  let issued = false,
    inFlight: Promise<boolean> | null = null;
  let pendingAction: (() => void) | undefined;
  const execute = () => {
    if (issued) return;
    issued = true;
    environment.document.querySelector("[data-sw-update-banner]")?.remove();
    updateBanners();
    pendingAction?.();
  };
  const approve = async (deferForOpenReaders: boolean) => {
    if (environment.hasAttachments?.() || (deferForOpenReaders && openReaders.size))
      return false;
    if (!(await environment.flushPendingEdits())) return false;
    if (deferForOpenReaders && openReaders.size) return false;
    execute();
    return true;
  };
  return {
    request(
      action: () => void = environment.reload,
      automatic = true,
    ): Promise<boolean> {
      if (issued) return Promise.resolve(true);
      if (inFlight) return inFlight;
      pendingAction ??= action;
      const defer = () => {
        showUpdateBanner(environment.document, () => approve(false), automatic && openReaders.size > 0 && !environment.hasPendingEdits() && !environment.hasAttachments?.(), environment.translate ?? adminTranslation);
        return false;
      };
      if (openReaders.size) return Promise.resolve(defer());
      if (!environment.hasPendingEdits()) {
        execute();
        return Promise.resolve(true);
      }
      if (!automatic || environment.hasAttachments?.())
        return Promise.resolve(defer());
      inFlight = approve(true)
        .then((approved) => approved || defer())
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

let browserCoordinator:
  | ReturnType<typeof createDashboardReloadCoordinator>
  | undefined;
export function dashboardReloadCoordinator() {
  return (browserCoordinator ??= createDashboardReloadCoordinator({
    document,
    reload: () => window.location.reload(),
    hasPendingEdits: hasPendingDashboardMutations,
    hasAttachments: hasPendingDashboardAttachments,
    flushPendingEdits: () => waitForDashboardMutationsToFlush(),
  }));
}

function showUpdateBanner(
  document: Document,
  apply: () => Promise<boolean>,
  reading: boolean,
  translate: () => AdminTranslate,
): void {
  const t = translate();
  if (document.querySelector("[data-sw-update-banner]")) return;
  const banner = document.createElement("div");
  banner.dataset.swUpdateBanner = "true";
  banner.setAttribute("role", "status");
  Object.assign(banner.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px 14px",
    borderRadius: "var(--radius-floor)",
    background: "#171717",
    color: "#fff",
    boxShadow: "0 8px 30px rgba(0, 0, 0, 0.35)",
    font: "14px/1.4 system-ui, sans-serif",
  });
  const message = document.createElement("span");
  message.textContent = reading
    ? "새 버전이 나왔습니다. 문서를 읽는 동안은 저절로 새로 고치지 않습니다"
    : t("admin.pwa.reviewDraft");
  const action = document.createElement("button");
  action.type = "button";
  action.dataset.swUpdateAction = "true";
  action.textContent = t("admin.pwa.apply");
  Object.assign(action.style, {
    border: "1px solid rgba(255, 255, 255, 0.35)",
    borderRadius: "var(--radius-floor)",
    padding: "6px 10px",
    background: "#fff",
    color: "#111",
    cursor: "pointer",
    font: "inherit",
    fontWeight: "600",
  });
  action.addEventListener("click", () => {
    const t = translate();
    action.disabled = true;
    action.textContent = t("admin.pwa.saving");
    void apply().then((approved) => {
      if (approved) return;
      action.disabled = false;
      action.textContent = t("admin.pwa.retry");
      message.textContent =
        t("admin.pwa.savePending");
    });
  });
  banner.append(message, action);
  document.body.appendChild(banner);
  positionBanner(document, banner);
}

function positionBanner(document: Document, banner: HTMLElement): void {
  const view = document.defaultView!;
  let content: HTMLElement | null = null;
  let originalPadding = "";
  let basePadding = "";
  let observedFooter: HTMLElement | null = null;
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => update());
  const restoreContent = () => {
    if (content) content.style.paddingBottom = originalPadding;
    content = null;
  };
  const cleanup = () => {
    restoreContent();
    observer?.disconnect();
    view.removeEventListener("resize", update);
    bannerUpdates.delete(update);
  };
  const update = () => {
    if (!banner.isConnected) { cleanup(); return; }
    const reader = Array.from(openReaders).at(-1)?.();
    const footer = reader?.footer ?? null;
    if (footer !== observedFooter) {
      if (observedFooter) observer?.unobserve(observedFooter);
      if (observedFooter?.parentElement) observer?.unobserve(observedFooter.parentElement);
      if (footer) observer?.observe(footer);
      if (footer?.parentElement) observer?.observe(footer.parentElement);
      observedFooter = footer;
    }
    banner.style.bottom = footer ? `${Math.max(16, view.innerHeight - footer.getBoundingClientRect().top + 16)}px` : "16px";
    const nextContent = reader?.content ?? null;
    if (content !== nextContent) {
      restoreContent();
      content = nextContent;
      if (content) {
        originalPadding = content.style.paddingBottom;
        basePadding = view.getComputedStyle(content).paddingBottom || "0px";
      }
    }
    if (content) content.style.paddingBottom = `calc(${basePadding} + ${banner.getBoundingClientRect().height + 16}px)`;
  };
  bannerUpdates.add(update);
  view.addEventListener("resize", update);
  observer?.observe(banner);
  update();
}
