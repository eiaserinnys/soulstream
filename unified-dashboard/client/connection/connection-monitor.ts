import { subscribeOrchestratorHints } from "@seosoyoung/soul-ui/lib/orchestrator-connection";

export type ConnectionPhase =
  | "connected"
  | "planned"
  | "disconnected"
  | "checking"
  | "recovering"
  | "new-version";
export interface ConnectionSnapshot {
  phase: ConnectionPhase;
  fresh: boolean;
}
interface Health {
  healthy: boolean;
  ready: boolean;
  draining: boolean;
  build_id: string;
}
export function createConnectionMonitor(options: {
  buildId: string;
  fetch: typeof globalThis.fetch;
  recover(): Promise<void>;
  reload(): Promise<boolean>;
}) {
  let state: ConnectionSnapshot = { phase: "connected", fresh: true };
  let connectedOnce = false,
    active = false,
    generation = 0,
    shutdownRevision = 0;
  let inFlight: Promise<void> | null = null,
    abort: AbortController | null = null;
  let interval: ReturnType<typeof setInterval> | undefined,
    unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (phase: ConnectionPhase) => {
    state = { phase, fresh: !connectedOnce };
    for (const listener of listeners) listener();
    if (phase === "connected") {
      if (interval) clearInterval(interval);
      interval = undefined;
    } else if (!interval) interval = setInterval(() => void check(), 5000);
  };
  const check = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (!active) return Promise.resolve();
    const currentGeneration = generation,
      currentShutdown = shutdownRevision,
      controller = new AbortController();
    abort = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    if (state.phase === "disconnected") publish("checking");
    const request = (async () => {
      try {
        const response = await options.fetch("/api/health", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Orchestrator health unavailable");
        const health = (await response.json()) as Health;
        if (
          !active ||
          generation !== currentGeneration ||
          currentShutdown !== shutdownRevision
        )
          return;
        if (!health.healthy || !health.ready || health.draining) {
          publish(health.draining ? "planned" : "disconnected");
          return;
        }
        const differentBuild =
          options.buildId !== "dev" &&
          health.build_id !== "dev" &&
          health.build_id !== options.buildId;
        const recovering = state.phase !== "connected";
        if (differentBuild) {
          publish("new-version");
          if (await options.reload()) return;
          publish("recovering");
          await options.recover();
        } else if (recovering) {
          publish("recovering");
          await options.recover();
        }
        if (
          !active ||
          generation !== currentGeneration ||
          currentShutdown !== shutdownRevision
        )
          return;
        connectedOnce = true;
        publish("connected");
      } catch {
        if (active && generation === currentGeneration) publish("disconnected");
      } finally {
        clearTimeout(timeout);
        if (abort === controller) abort = null;
      }
    })().finally(() => {
      if (generation === currentGeneration) {
        inFlight = null;
        if (currentShutdown !== shutdownRevision) void check();
      }
    });
    inFlight = request;
    return request;
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") void check();
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check,
    start() {
      if (active) return;
      active = true;
      generation++;
      unsubscribe = subscribeOrchestratorHints((hint) => {
        if (hint === "shutdown") {
          shutdownRevision++;
          publish("planned");
        }
        void check();
      });
      document.addEventListener("visibilitychange", onVisibility);
      void check();
    },
    stop() {
      active = false;
      generation++;
      unsubscribe?.();
      document.removeEventListener("visibilitychange", onVisibility);
      if (interval) clearInterval(interval);
      interval = undefined;
      abort?.abort();
      inFlight = null;
    },
  };
}

export {
  registerConnectionRecovery,
  resynchronizeDashboard,
} from "@seosoyoung/soul-ui/lib/orchestrator-connection";
