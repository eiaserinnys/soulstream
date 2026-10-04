import {createDashboardReloadCoordinator,dashboardReloadCoordinator} from "./dashboard-reload";
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

type ActivationSource = Pick<ServiceWorker, "state" | "postMessage" | "addEventListener" | "removeEventListener">;

type UpdateEnvironment = {
  readonly serviceWorker: ServiceWorkerContainerLike | undefined;
  readonly document: Document;
  readonly reload: () => void;
  readonly setInterval: (callback: () => void, timeout: number) => number;
  readonly clearInterval: (id: number) => void;
  readonly warn: (message: string, error?: unknown) => void;
  readonly hasPendingEdits: () => boolean;
  readonly flushPendingEdits: () => Promise<boolean>;
  readonly reloadCoordinator?: ReturnType<typeof createDashboardReloadCoordinator>;
};

export async function registerDashboardServiceWorker(
  environment: UpdateEnvironment = browserEnvironment(),
): Promise<() => void> {
  const { serviceWorker, document } = environment;
  const reloadCoordinator=environment.reloadCoordinator??createDashboardReloadCoordinator(environment);
  if (!serviceWorker) return () => undefined;

  const onMessage: EventListener = (rawEvent) => {
    const event = rawEvent as MessageEvent<unknown>;
    const data = activationMessage(event.data);
    if (!data) return;
    const source = event.source as ActivationSource | null;
    const approve=()=>{
      if(source)afterWorkerActivation(source,()=>source.postMessage({ type: APPROVE_RELOAD_MESSAGE, token: data.token }));
      else environment.reload();
    };
    const respond=()=>{
      if(environment.hasPendingEdits())source?.postMessage({type:DEFER_RELOAD_MESSAGE,token:data.token});
      void reloadCoordinator.request(approve,false);
    };
    // Defer immediately; approval must not start navigation inside activate.
    if (source && !environment.hasPendingEdits()) afterWorkerActivation(source, respond);
    else respond();
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

function afterWorkerActivation(worker: ActivationSource, action: () => void): void {
  if (worker.state === "activated") { action(); return; }
  const onStateChange = () => {
    if (worker.state !== "activated") return;
    worker.removeEventListener("statechange", onStateChange);
    action();
  };
  worker.addEventListener("statechange", onStateChange);
}

function activationMessage(value: unknown): { token: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return record.type === ACTIVATED_MESSAGE && typeof record.token === "string"
    ? { token: record.token }
    : null;
}

function browserEnvironment(): UpdateEnvironment {
  return {
    serviceWorker: "serviceWorker" in navigator
      ? navigator.serviceWorker as unknown as ServiceWorkerContainerLike
      : undefined,
    document,
    reloadCoordinator:dashboardReloadCoordinator(),
    reload: () => window.location.reload(),
    setInterval: (callback, timeout) => window.setInterval(callback, timeout),
    clearInterval: (id) => window.clearInterval(id),
    warn: (message, error) => console.warn(message, error),
    hasPendingEdits: hasPendingDashboardMutations,
    flushPendingEdits: () => waitForDashboardMutationsToFlush(),
  };
}
