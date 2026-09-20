/**
 * UI 사용 로그 수집기 — 순수 코어.
 *
 * window·fetch·타이머를 직접 만지지 않는다. 전부 주입받는다. 두 가지 이유다:
 * vitest가 `environment: "node"`로 돌아 브라우저 전역이 없고, 무엇보다
 * 큐·중복 제거·소유자 경계 같은 규칙은 브라우저 없이 검증할 수 있어야 한다.
 *
 * 브라우저 결합은 `browser-collector.ts`가 전담한다.
 */
import {
  UI_EVENT_SCHEMA_VERSION,
  type UiEventEntry,
  type UiEventAttrValue,
  type UiEventTargetKind,
  type UiEventType,
} from "../../../../../orch-server-ts/src/ui-events/ui_event_contract";

export { UI_EVENT_SCHEMA_VERSION };
export type { UiEventAttrValue, UiEventEntry, UiEventTargetKind, UiEventType };

export type UiEventRef = { readonly kind: UiEventTargetKind; readonly id: string };

/** `track` 호출자가 채우는 부분. 봉투와 seq, eventId는 수집기가 붙인다. */
export type UiEventDraft = {
  readonly target?: UiEventRef | null;
  readonly from?: UiEventRef | null;
  readonly entry?: UiEventEntry | null;
  readonly flowId?: string | null;
  readonly attrs?: Readonly<Record<string, UiEventAttrValue>>;
};

export type UiEventPayload = UiEventDraft & {
  readonly eventId: string;
  readonly seq: number;
  readonly occurredAt: string;
  readonly type: UiEventType;
};

/** 이벤트가 생긴 당시의 실행 정보. 큐에 이벤트와 함께 붙어 다닌다. */
export type UiEventEnvelope = {
  readonly installId: string;
  readonly clientSessionKey: string;
  readonly appVersion: string;
};

export type QueuedUiEvent = {
  readonly envelope: UiEventEnvelope;
  readonly event: UiEventPayload;
};

/**
 * 대기열의 임자. 서버 주소나 사용자가 바뀌면 옛 기록을 보내지 않고 버리기 위한 표식이다.
 */
export type UiEventOwner = {
  readonly origin: string;
  readonly userEmail: string;
};

export type UiEventTransportResult =
  /** 서버가 받았다. 거절된 이벤트가 섞여 있어도 다시 보내지 않는다. */
  | { readonly kind: "ok" }
  /** 413·422. 같은 내용을 다시 보내도 답은 같다 — 그냥 버린다. */
  | { readonly kind: "permanent" }
  /** 5xx·네트워크 오류. 대기열에 남겨 다음 기회에 다시 보낸다. */
  | { readonly kind: "retry" };

export type UiEventTransport = (
  envelope: UiEventEnvelope,
  events: readonly UiEventPayload[],
) => Promise<UiEventTransportResult>;

export type UiEventQueueSnapshot = {
  readonly owner: UiEventOwner;
  readonly items: readonly QueuedUiEvent[];
};

export type UiEventQueueStorage = {
  readonly read: () => UiEventQueueSnapshot | null;
  readonly write: (snapshot: UiEventQueueSnapshot) => void;
  readonly clear: () => void;
};

export type UiEventClientConfig = {
  readonly enabled: boolean;
  readonly flushIntervalMs: number;
  readonly maxBatchSize: number;
  readonly maxQueueSize: number;
};

export const UI_EVENT_CLIENT_CONFIG_OFF: UiEventClientConfig = {
  enabled: false,
  flushIntervalMs: 10_000,
  maxBatchSize: 20,
  maxQueueSize: 500,
};

export type CreateUiEventCollectorOptions = {
  readonly envelope: UiEventEnvelope;
  readonly owner: UiEventOwner;
  readonly transport: UiEventTransport;
  readonly storage: UiEventQueueStorage;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly config?: UiEventClientConfig;
  readonly onWarning?: (message: string, error: unknown) => void;
};

export type UiEventCollector = {
  /** 수집이 꺼져 있으면 아무 일도 하지 않는다. 절대 예외를 던지지 않는다. */
  readonly track: (type: UiEventType, draft?: UiEventDraft) => void;
  /**
   * 다음 `view_open`이 집어 갈 진입경로를 미리 찍어 둔다.
   * 네비게이션을 일으키는 클릭 자리에서 부른다. 한 번 쓰이면 사라진다.
   */
  readonly markEntry: (entry: UiEventEntry) => void;
  readonly flush: () => Promise<void>;
  readonly setConfig: (config: UiEventClientConfig) => void;
  readonly getConfig: () => UiEventClientConfig;
  /** 비활성 전환 시점에 대기열을 영속 저장으로 내린다. */
  readonly persist: () => void;
  /** 임자가 바뀌었다. 보내지 않은 것은 전부 버린다. */
  readonly resetOwner: (owner: UiEventOwner) => void;
  readonly pending: () => readonly QueuedUiEvent[];
};

/** 아무것도 하지 않는 수집기. Provider 기본값이라 계측이 없어도 화면은 멀쩡하다. */
export const NOOP_UI_EVENT_COLLECTOR: UiEventCollector = {
  track: () => undefined,
  markEntry: () => undefined,
  flush: async () => undefined,
  setConfig: () => undefined,
  getConfig: () => UI_EVENT_CLIENT_CONFIG_OFF,
  persist: () => undefined,
  resetOwner: () => undefined,
  pending: () => [],
};

export function createUiEventCollector(
  options: CreateUiEventCollectorOptions,
): UiEventCollector {
  let config = options.config ?? UI_EVENT_CLIENT_CONFIG_OFF;
  let owner = options.owner;
  let queue: QueuedUiEvent[] = [];
  let seq = 0;
  let flushing = false;
  const entryHint = createUiEventEntryHint(() => options.now().getTime());

  // 부팅 시 영속 대기열을 이어받는다. 임자가 다르면 보내지 않고 버린다 —
  // 다른 사용자나 다른 서버로 옛 기록이 흘러가는 경로를 여기서 끊는다.
  restore();

  function restore(): void {
    const snapshot = safely(() => options.storage.read(), null);
    if (snapshot === null) return;
    if (!sameOwner(snapshot.owner, owner)) {
      safely(() => options.storage.clear(), undefined);
      return;
    }
    queue = [...snapshot.items];
  }

  function persist(): void {
    safely(() => {
      if (queue.length === 0) options.storage.clear();
      else options.storage.write({ owner, items: queue });
    }, undefined);
  }

  function track(type: UiEventType, draft: UiEventDraft = {}): void {
    if (!config.enabled) return;
    try {
      seq += 1;
      // 진입경로를 호출자가 직접 주지 않았으면 직전 클릭이 남긴 힌트를 쓴다.
      // 힌트도 없으면 `nav` — "그냥 이동했다"이지 "자동"이 아니다.
      const entry = type === "view_open" && draft.entry === undefined
        ? entryHint.consume() ?? "nav"
        : draft.entry;
      queue.push({
        envelope: options.envelope,
        event: {
          eventId: options.newId(),
          seq,
          occurredAt: options.now().toISOString(),
          type,
          ...draft,
          ...(entry === undefined ? {} : { entry }),
        },
      });
      // 상한을 넘으면 가장 오래된 것부터 버린다. 대기열은 자라지 않는다.
      if (queue.length > config.maxQueueSize) {
        queue = queue.slice(queue.length - config.maxQueueSize);
      }
      if (queue.length >= config.maxBatchSize) void flush();
    } catch (error) {
      options.onWarning?.("UI 사용 로그 기록 실패", error);
    }
  }

  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      // 이번 flush 가 책임질 범위를 진입 시점에 고정한다. 전송하는 동안 새로
      // 들어온 이벤트까지 쫓아가면 끝나지 않는다 — 그건 다음 주기가 가져간다.
      const remaining = new Set(queue.map((item) => item.event.eventId));

      // 한 번에 하나의 봉투만 보낸다. 재기동을 건너온 이벤트는 자기 실행의
      // installId/clientSessionKey/appVersion 을 그대로 지닌 채 따로 나간다.
      while (remaining.size > 0) {
        const scope = queue.filter((item) => remaining.has(item.event.eventId));
        const envelope = scope[0]?.envelope;
        if (envelope === undefined) break;
        const batch = scope
          .filter((item) => sameEnvelope(item.envelope, envelope))
          .slice(0, config.maxBatchSize);
        if (batch.length === 0) break;

        const sentIds = new Set(batch.map((item) => item.event.eventId));
        let result: UiEventTransportResult;
        try {
          result = await options.transport(envelope, batch.map((item) => item.event));
        } catch (error) {
          options.onWarning?.("UI 사용 로그 전송 실패", error);
          result = { kind: "retry" };
        }

        if (result.kind === "retry") {
          // 전용 백오프를 두지 않는다. 다음 정규 flush나 활성 복귀 때 다시 시도된다.
          persist();
          return;
        }
        // ok든 permanent든 이 요청에 실었던 것만 지운다.
        // 전송 중 새로 들어온 이벤트는 인덱스가 아니라 id 집합으로 보호된다.
        queue = queue.filter((item) => !sentIds.has(item.event.eventId));
        for (const id of sentIds) remaining.delete(id);
      }
      persist();
    } finally {
      flushing = false;
    }
  }

  return {
    track,
    markEntry: (entry) => entryHint.mark(entry),
    flush,
    setConfig(next) {
      config = next;
      if (!next.enabled) {
        // 끄면 보내지 않은 것도 남기지 않는다.
        queue = [];
        safely(() => options.storage.clear(), undefined);
      }
    },
    getConfig: () => config,
    persist,
    resetOwner(next) {
      if (sameOwner(next, owner)) return;
      owner = next;
      queue = [];
      seq = 0;
      safely(() => options.storage.clear(), undefined);
    },
    pending: () => queue,
  };

  function safely<T>(action: () => T, fallback: T): T {
    try {
      return action();
    } catch (error) {
      options.onWarning?.("UI 사용 로그 저장소 접근 실패", error);
      return fallback;
    }
  }
}

function sameOwner(a: UiEventOwner, b: UiEventOwner): boolean {
  return a.origin === b.origin && a.userEmail === b.userEmail;
}

function sameEnvelope(a: UiEventEnvelope, b: UiEventEnvelope): boolean {
  return a.installId === b.installId &&
    a.clientSessionKey === b.clientSessionKey &&
    a.appVersion === b.appVersion;
}

/**
 * 진입경로 힌트.
 *
 * 화면 전환 자체는 store 구독이 잡지만, "어디를 눌러서 왔는가"는 store 차분에
 * 남지 않는다. 네비게이션을 일으키는 자리에서 이것을 먼저 찍어 두면
 * 바로 뒤에 오는 `view_open`이 집어 간다.
 *
 * 한 번 읽히면 사라진다 — 오래된 힌트가 엉뚱한 전환에 붙지 않게 하려는 것이다.
 */
export type UiEventEntryHint = {
  readonly mark: (entry: UiEventEntry) => void;
  readonly consume: () => UiEventEntry | null;
};

export function createUiEventEntryHint(
  now: () => number = () => Date.now(),
  ttlMs = 1_000,
): UiEventEntryHint {
  let pending: { entry: UiEventEntry; at: number } | null = null;
  return {
    mark(entry) {
      pending = { entry, at: now() };
    },
    consume() {
      if (pending === null) return null;
      const { entry, at } = pending;
      pending = null;
      return now() - at <= ttlMs ? entry : null;
    },
  };
}
