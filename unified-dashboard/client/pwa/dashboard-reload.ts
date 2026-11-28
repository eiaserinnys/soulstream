import { adminTranslation, type AdminTranslate } from "../components/config/admin-translation";
import {
  hasPendingDashboardAttachments,
  hasPendingDashboardMutations,
  waitForDashboardMutationsToFlush,
} from "@seosoyoung/soul-ui/pending-mutation-registry";

const openReaders = new Set<symbol>();
export function registerDashboardReader(): () => void {
  const token = Symbol();
  openReaders.add(token);
  return () => { openReaders.delete(token); };
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
        showUpdateBanner(environment.document, () => approve(false), environment.translate ?? adminTranslation);
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
  translate: () => AdminTranslate,
): void {
  const t = translate();
  if (document.querySelector("[data-sw-update-banner]")) return;
  const banner = document.createElement("div");
  banner.dataset.swUpdateBanner = "true";
  banner.setAttribute("role", "status");
  // Preserve the existing service-worker update banner; connection dialogs use registered tokens.
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
  message.textContent = t("admin.pwa.reviewDraft");
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
}
