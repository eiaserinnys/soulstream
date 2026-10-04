import {
  hasPendingDashboardAttachments,
  hasPendingDashboardMutations,
  waitForDashboardMutationsToFlush,
} from "@seosoyoung/soul-ui/pending-mutation-registry";

export interface ReloadEnvironment {
  document: Document;
  reload(): void;
  hasPendingEdits(): boolean;
  flushPendingEdits(): Promise<boolean>;
  hasAttachments?(): boolean;
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
  const approve = async () => {
    if (environment.hasAttachments?.()) return false;
    if (!(await environment.flushPendingEdits())) return false;
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
      if (!environment.hasPendingEdits()) {
        execute();
        return Promise.resolve(true);
      }
      const defer = () => {
        showUpdateBanner(environment.document, approve);
        return false;
      };
      if (!automatic || environment.hasAttachments?.())
        return Promise.resolve(defer());
      inFlight = approve()
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
): void {
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
    borderRadius: "12px",
    background: "#171717",
    color: "#fff",
    boxShadow: "0 8px 30px rgba(0, 0, 0, 0.35)",
    font: "14px/1.4 system-ui, sans-serif",
  });
  const message = document.createElement("span");
  message.textContent = "작성 중인 내용을 확인한 뒤 새로고침합니다";
  const action = document.createElement("button");
  action.type = "button";
  action.dataset.swUpdateAction = "true";
  action.textContent = "새 버전 적용";
  Object.assign(action.style, {
    border: "1px solid rgba(255, 255, 255, 0.35)",
    borderRadius: "8px",
    padding: "6px 10px",
    background: "#fff",
    color: "#111",
    cursor: "pointer",
    font: "inherit",
    fontWeight: "600",
  });
  action.addEventListener("click", () => {
    action.disabled = true;
    action.textContent = "편집 저장 중…";
    void apply().then((approved) => {
      if (approved) return;
      action.disabled = false;
      action.textContent = "다시 시도";
      message.textContent =
        "편집 저장이 아직 끝나지 않았습니다. 잠시 후 다시 시도하세요.";
    });
  });
  banner.append(message, action);
  document.body.appendChild(banner);
}
