/**
 * 브라우저 어댑터. window·localStorage·fetch·타이머와의 결합은 전부 여기에만 둔다.
 */
import {
  UI_EVENT_CLIENT_CONFIG_OFF,
  UI_EVENT_SCHEMA_VERSION,
  createUiEventCollector,
  type QueuedUiEvent,
  type UiEventClientConfig,
  type UiEventCollector,
  type UiEventEnvelope,
  type UiEventOwner,
  type UiEventPayload,
  type UiEventQueueStorage,
  type UiEventTransportResult,
} from "./collector";

const INSTALL_ID_KEY = "soulstream:ui-events:install-id:v1";
const QUEUE_KEY = "soulstream:ui-events:queue:v1";
const CONFIG_ENDPOINT = "/api/ui-events/config";
const INGEST_ENDPOINT = "/api/ui-events";

export type BrowserUiEventCollector = {
  readonly collector: UiEventCollector;
  /** 리스너·타이머를 걷는다. */
  readonly dispose: () => void;
};

export type StartBrowserUiEventCollectorOptions = {
  readonly userEmail: string;
  readonly appVersion: string;
  readonly onWarning?: (message: string, error: unknown) => void;
};

/**
 * 브라우저 수집기를 켠다.
 *
 * 설정을 먼저 한 번 읽고, 실패하면 그 순간에는 수집하지 않되 **다음 활성 복귀 때
 * 다시 읽어** 회복한다. 상시 polling은 하지 않는다.
 */
export function startBrowserUiEventCollector(
  options: StartBrowserUiEventCollectorOptions,
): BrowserUiEventCollector {
  const envelope: UiEventEnvelope = {
    installId: resolveInstallId(),
    clientSessionKey: randomId(),
    appVersion: options.appVersion,
  };
  const owner: UiEventOwner = {
    origin: window.location.origin,
    userEmail: options.userEmail,
  };

  const collector = createUiEventCollector({
    envelope,
    owner,
    transport: postBatch,
    storage: createLocalStorageQueue(),
    now: () => new Date(),
    newId: randomId,
    ...(options.onWarning ? { onWarning: options.onWarning } : {}),
  });

  let configLoaded = false;
  let disposed = false;

  async function loadConfig(): Promise<void> {
    if (disposed || configLoaded) return;
    try {
      const response = await fetch(CONFIG_ENDPOINT, { credentials: "same-origin" });
      if (!response.ok) return;
      const body: unknown = await response.json();
      collector.setConfig(readConfig(body));
      configLoaded = true;
    } catch (error) {
      // 여기서 영구히 꺼지지 않는다. 다음 활성 복귀 때 다시 읽는다.
      options.onWarning?.("UI 사용 로그 설정 조회 실패", error);
    }
  }

  void loadConfig();

  // 서버가 정한 주기를 따라야 하므로 고정 setInterval 대신 매 회차 설정을 다시 읽는다.
  let flushTimer = 0;
  const scheduleFlush = (): void => {
    if (disposed) return;
    flushTimer = window.setTimeout(() => {
      void collector.flush().finally(scheduleFlush);
    }, collector.getConfig().flushIntervalMs);
  };
  scheduleFlush();

  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      collector.track("app_inactive", { attrs: { reason: "hidden" } });
      collector.persist();
      beaconFlush(collector);
      return;
    }
    collector.track("app_active");
    void loadConfig();
    void collector.flush();
  };

  const onPageHide = (): void => {
    collector.track("app_inactive", { attrs: { reason: "pagehide" } });
    collector.persist();
    beaconFlush(collector);
  };

  window.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);

  return {
    collector,
    dispose() {
      disposed = true;
      window.clearTimeout(flushTimer);
      window.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      collector.persist();
    },
  };
}

/**
 * 언로드 직전의 마지막 시도. 도달을 보장하지 않는다(best effort).
 * `sendBeacon`은 같은 오리진이라 쿠키가 함께 간다.
 */
function beaconFlush(collector: UiEventCollector): void {
  try {
    const pending = collector.pending();
    if (pending.length === 0) return;
    const envelope = pending[0]?.envelope;
    if (envelope === undefined) return;
    const events = pending
      .filter((item) => item.envelope.installId === envelope.installId &&
        item.envelope.clientSessionKey === envelope.clientSessionKey)
      .slice(0, collector.getConfig().maxBatchSize)
      .map((item) => item.event);
    if (events.length === 0) return;
    const blob = new Blob([JSON.stringify(body(envelope, events))], {
      type: "application/json",
    });
    navigator.sendBeacon?.(INGEST_ENDPOINT, blob);
  } catch {
    // 언로드 경로에서 실패해도 할 수 있는 일이 없다.
  }
}

async function postBatch(
  envelope: UiEventEnvelope,
  events: readonly UiEventPayload[],
): Promise<UiEventTransportResult> {
  const response = await fetch(INGEST_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body(envelope, events)),
  });
  // 413·422는 같은 내용을 다시 보내도 답이 같다. 분할 재시도 경로를 두지 않는다.
  if (response.status === 413 || response.status === 422) return { kind: "permanent" };
  if (!response.ok) return { kind: "retry" };
  return { kind: "ok" };
}

function body(
  envelope: UiEventEnvelope,
  events: readonly UiEventPayload[],
): Record<string, unknown> {
  return {
    schemaVersion: UI_EVENT_SCHEMA_VERSION,
    installId: envelope.installId,
    clientSessionKey: envelope.clientSessionKey,
    appVersion: envelope.appVersion,
    events,
  };
}

export function readConfig(raw: unknown): UiEventClientConfig {
  if (!isRecord(raw)) return UI_EVENT_CLIENT_CONFIG_OFF;
  return {
    enabled: raw.enabled === true,
    flushIntervalMs: integer(raw.flushIntervalMs, UI_EVENT_CLIENT_CONFIG_OFF.flushIntervalMs),
    maxBatchSize: integer(raw.maxBatchSize, UI_EVENT_CLIENT_CONFIG_OFF.maxBatchSize),
    maxQueueSize: integer(raw.maxQueueSize, UI_EVENT_CLIENT_CONFIG_OFF.maxQueueSize),
  };
}

function createLocalStorageQueue(): UiEventQueueStorage {
  return {
    read() {
      const raw = window.localStorage.getItem(QUEUE_KEY);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.owner) || !Array.isArray(parsed.items)) {
        return null;
      }
      const storedOwner = parsed.owner;
      if (typeof storedOwner.origin !== "string" || typeof storedOwner.userEmail !== "string") {
        return null;
      }
      return {
        owner: { origin: storedOwner.origin, userEmail: storedOwner.userEmail },
        items: parsed.items as QueuedUiEvent[],
      };
    },
    write(snapshot) {
      window.localStorage.setItem(QUEUE_KEY, JSON.stringify(snapshot));
    },
    clear() {
      window.localStorage.removeItem(QUEUE_KEY);
    },
  };
}

function resolveInstallId(): string {
  const existing = window.localStorage.getItem(INSTALL_ID_KEY);
  if (existing !== null && existing.length > 0) return existing;
  const created = randomId();
  window.localStorage.setItem(INSTALL_ID_KEY, created);
  return created;
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

function integer(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? (value as number) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
