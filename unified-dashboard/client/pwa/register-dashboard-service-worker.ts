import {
  hasPendingDashboardMutations,
  waitForDashboardMutationsToFlush,
} from "@seosoyoung/soul-ui";

const UPDATE_INTERVAL_MS = 60 * 60 * 1_000;
const ACTIVATED_MESSAGE = "SOULSTREAM_SW_ACTIVATED";
const DEFER_RELOAD_MESSAGE = "SOULSTREAM_SW_DEFER_RELOAD";
const APPROVE_RELOAD_MESSAGE = "SOULSTREAM_SW_APPROVE_RELOAD";
const CAPABLE_MESSAGE = "SOULSTREAM_SW_CAPABLE";

type RegistrationLike = {
  update(): Promise<unknown>;
  readonly active?: { postMessage(message: unknown): void } | null;
  readonly installing?: { postMessage(message: unknown): void } | null;
  addEventListener?(type: "updatefound", listener: EventListener): void;
  removeEventListener?(type: "updatefound", listener: EventListener): void;
};

type ServiceWorkerContainerLike = {
  register(scriptURL: string, options: RegistrationOptions): Promise<RegistrationLike>;
  addEventListener(type: "message", listener: EventListener): void;
  removeEventListener(type: "message", listener: EventListener): void;
  readonly controller?: { postMessage(message: unknown): void } | null;
};

type UpdateEnvironment = {
  readonly serviceWorker: ServiceWorkerContainerLike | undefined;
  readonly document: Document;
  readonly reload: () => void;
  readonly setInterval: (callback: () => void, timeout: number) => number;
  readonly clearInterval: (id: number) => void;
  readonly warn: (message: string, error?: unknown) => void;
  readonly hasPendingEdits: () => boolean;
  readonly flushPendingEdits: () => Promise<boolean>;
};

export async function registerDashboardServiceWorker(
  environment: UpdateEnvironment = browserEnvironment(),
): Promise<() => void> {
  const { serviceWorker, document } = environment;
  if (!serviceWorker) return () => undefined;

  const onMessage: EventListener = (rawEvent) => {
    const event = rawEvent as MessageEvent<unknown>;
    const data = activationMessage(event.data);
    if (!data) return;
    const source = event.source as { postMessage?: (message: unknown) => void } | null;
    if (!environment.hasPendingEdits()) {
      source?.postMessage?.({ type: APPROVE_RELOAD_MESSAGE, token: data.token });
      return;
    }
    source?.postMessage?.({ type: DEFER_RELOAD_MESSAGE, token: data.token });
    showUpdateBanner(document, async () => {
      if (!await environment.flushPendingEdits()) return false;
      if (source?.postMessage) {
        source.postMessage({ type: APPROVE_RELOAD_MESSAGE, token: data.token });
      } else {
        environment.reload();
      }
      return true;
    });
  };
  serviceWorker.addEventListener("message", onMessage);

  let registration: RegistrationLike | undefined;
  let intervalId: number | undefined;
  let onUpdateFound: EventListener | undefined;
  const checkForUpdate = () => {
    if (!registration) return;
    void registration.update().catch((error: unknown) => {
      environment.warn("Service worker update check failed", error);
    });
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") checkForUpdate();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  try {
    registration = await serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
  } catch (error) {
    environment.warn("Service worker registration failed", error);
    return () => {
      serviceWorker.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }
  const announceCapability = () => {
    const message = { type: CAPABLE_MESSAGE };
    registration?.active?.postMessage(message);
    registration?.installing?.postMessage(message);
    serviceWorker.controller?.postMessage(message);
  };
  onUpdateFound = () => announceCapability();
  registration.addEventListener?.("updatefound", onUpdateFound);
  announceCapability();
  intervalId = environment.setInterval(checkForUpdate, UPDATE_INTERVAL_MS);
  checkForUpdate();

  return () => {
    serviceWorker.removeEventListener("message", onMessage);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (onUpdateFound) registration?.removeEventListener?.("updatefound", onUpdateFound);
    if (intervalId !== undefined) environment.clearInterval(intervalId);
  };
}

function activationMessage(value: unknown): { token: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return record.type === ACTIVATED_MESSAGE && typeof record.token === "string"
    ? { token: record.token }
    : null;
}

function showUpdateBanner(document: Document, apply: () => Promise<boolean>): void {
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
    borderRadius: "12px",
    background: "#171717",
    color: "#fff",
    boxShadow: "0 8px 30px rgba(0, 0, 0, 0.35)",
    font: "14px/1.4 system-ui, sans-serif",
  });
  const message = document.createElement("span");
  message.textContent = "새 버전이 준비됐습니다. 편집 내용을 확인한 뒤 적용하세요.";
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
      message.textContent = "편집 저장이 아직 끝나지 않았습니다. 잠시 후 다시 시도하세요.";
    });
  });
  banner.append(message, action);
  document.body.appendChild(banner);
}

function browserEnvironment(): UpdateEnvironment {
  return {
    serviceWorker: "serviceWorker" in navigator
      ? navigator.serviceWorker as unknown as ServiceWorkerContainerLike
      : undefined,
    document,
    reload: () => window.location.reload(),
    setInterval: (callback, timeout) => window.setInterval(callback, timeout),
    clearInterval: (id) => window.clearInterval(id),
    warn: (message, error) => console.warn(message, error),
    hasPendingEdits: hasPendingDashboardMutations,
    flushPendingEdits: () => waitForDashboardMutationsToFlush(),
  };
}
