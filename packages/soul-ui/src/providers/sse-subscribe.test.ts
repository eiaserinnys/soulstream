/**
 * createSSESubscribe 재연결 테스트 (Phase 3 viewport API)
 *
 * SSE 연결이 끊긴 후:
 * 1) 지수 백오프로 재연결을 시도하는지
 * 2) 재연결 URL에 `?lastEventId=N`이 포함되는지
 * 3) 재연결 후 수신한 subtree_update 이벤트가 onEvent 콜백으로 전달되는지
 * 를 검증한다.
 *
 * 서버 재시작 시 history_sync + subtree_update 리플레이 파이프라인의
 * 클라이언트 측 전제를 고정한다.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

/**
 * 각 테스트에서 MockEventSource의 모든 인스턴스에 접근하기 위한 저장소.
 * createSSESubscribe는 내부에서 `new EventSource(url)`을 호출하는데, 우리는
 * 외부에서 해당 인스턴스의 onerror / listener를 직접 호출해야 한다.
 */
const instances: MockEventSource[] = [];

class MockEventSource {
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  listeners = new Map<string, Array<(e: MessageEvent) => void>>();

  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  // Test helpers
  emitOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(type: string, data: unknown, lastEventId: number) {
    const list = this.listeners.get(type) ?? [];
    const evt = {
      data: JSON.stringify(data),
      lastEventId: String(lastEventId),
    } as unknown as MessageEvent;
    for (const cb of list) cb(evt);
  }

  /**
   * Non-MessageEvent 형태의 오류 — 실제 네트워크 끊김 시 브라우저가 보내는 형태.
   * createSSESubscribe는 이 경우 close() + 지수 백오프 재연결을 스케줄한다.
   */
  emitError() {
    // 반드시 MessageEvent가 아니어야 한다 (MessageEvent면 재연결하지 않음)
    this.onerror?.(new Event("error"));
  }
}

beforeEach(() => {
  instances.length = 0;
  (globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource =
    MockEventSource;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// EventSource mock이 먼저 적용된 뒤 로드되도록 동적 import를 사용한다.
const loadModule = async () => {
  vi.resetModules();
  const mod = await import("./sse-subscribe");
  return mod.createSSESubscribe;
};

describe("createSSESubscribe — 재연결 및 lastEventId 전달", () => {
  it("초기 연결은 lastEventId 쿼리 없이 baseUrl을 사용한다", async () => {
    const createSSESubscribe = await loadModule();
    const baseUrl = "/api/sessions/abc/events";
    const unsubscribe = createSSESubscribe({ baseUrl, onEvent: vi.fn() });

    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe(baseUrl);

    unsubscribe();
  });

  it("initialLastEventId > 0이면 초기 URL에 lastEventId 쿼리가 포함된다", async () => {
    const createSSESubscribe = await loadModule();
    const baseUrl = "/api/sessions/abc/events";
    const unsubscribe = createSSESubscribe({
      baseUrl,
      onEvent: vi.fn(),
      initialLastEventId: 42,
    });

    expect(instances[0].url).toBe(`${baseUrl}?lastEventId=42`);

    unsubscribe();
  });

  it("수신한 이벤트는 onEvent로 전달되고 eventId가 누적된다", async () => {
    const createSSESubscribe = await loadModule();
    const baseUrl = "/api/sessions/abc/events";
    const onEvent = vi.fn();
    const unsubscribe = createSSESubscribe({ baseUrl, onEvent });

    instances[0].emit(
      "subtree_update",
      {
        type: "subtree_update",
        deltas: [{ event_id: 10, delta: 3 }],
        new_total_subtree_height: 13,
      },
      15,
    );

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "subtree_update" }),
      15,
    );

    unsubscribe();
  });

  it("id 없는 _live_only 이벤트는 브라우저 lastEventId가 남아 있어도 eventId=0으로 전달한다", async () => {
    const createSSESubscribe = await loadModule();
    const baseUrl = "/api/sessions/abc/events";
    const onEvent = vi.fn();
    const unsubscribe = createSSESubscribe({ baseUrl, onEvent });

    instances[0].emit(
      "user_message",
      { type: "user_message", text: "go", _event_id: 10 },
      10,
    );
    instances[0].emit(
      "text_start",
      {
        type: "text_start",
        _live_only: true,
        tool_use_id: "msg-live",
      },
      10,
    );
    instances[0].emit(
      "text_delta",
      {
        type: "text_delta",
        text: "streaming",
        _live_only: true,
        tool_use_id: "msg-live",
      },
      10,
    );

    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "user_message" }),
      10,
    );
    expect(onEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "text_start" }),
      0,
    );
    expect(onEvent).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ type: "text_delta" }),
      0,
    );

    instances[0].emitError();
    vi.advanceTimersByTime(3000);
    expect(instances[1].url).toBe(`${baseUrl}?lastEventId=10`);

    unsubscribe();
  });

  it("연결 오류 후 재연결 URL에 lastEventId 쿼리가 포함된다", async () => {
    const createSSESubscribe = await loadModule();
    const baseUrl = "/api/sessions/abc/events";
    const onEvent = vi.fn();
    const onStatusChange = vi.fn();
    const unsubscribe = createSSESubscribe({
      baseUrl,
      onEvent,
      onStatusChange,
    });

    // 1. 첫 이벤트로 currentLastEventId = 15
    instances[0].emit(
      "subtree_update",
      { type: "subtree_update", deltas: [], new_total_subtree_height: 100 },
      15,
    );

    // 2. 연결 오류 → 원본 EventSource는 close되고 reconnect가 스케줄된다
    instances[0].emitError();
    expect(instances[0].closed).toBe(true);
    expect(onStatusChange).toHaveBeenCalledWith("error");

    // 3. 재연결 지연(3000ms × 2^0 = 3000ms) 경과 → 새 EventSource 생성
    vi.advanceTimersByTime(3000);
    expect(instances).toHaveLength(2);
    expect(instances[1].url).toBe(`${baseUrl}?lastEventId=15`);

    // 4. 재연결된 스트림에서 subtree_update 수신 → onEvent로 전달
    instances[1].emit(
      "subtree_update",
      {
        type: "subtree_update",
        deltas: [{ event_id: 20, delta: 5 }],
        new_total_subtree_height: 18,
      },
      16,
    );

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "subtree_update" }),
      16,
    );

    unsubscribe();
  });

  it("두 번째 재연결은 지수 백오프로 6000ms 대기한다", async () => {
    const createSSESubscribe = await loadModule();
    const baseUrl = "/api/sessions/abc/events";
    const unsubscribe = createSSESubscribe({ baseUrl, onEvent: vi.fn() });

    // 첫 번째 오류 → 3000ms 대기
    instances[0].emitError();
    vi.advanceTimersByTime(3000);
    expect(instances).toHaveLength(2);

    // 두 번째 오류 → 6000ms 대기
    instances[1].emitError();
    vi.advanceTimersByTime(5999);
    expect(instances).toHaveLength(2); // 아직 생성 안됨
    vi.advanceTimersByTime(1);
    expect(instances).toHaveLength(3); // 6000ms 경과 → 생성

    unsubscribe();
  });

  it("구독 해제 시 EventSource가 close되고 pending reconnect도 취소된다", async () => {
    const createSSESubscribe = await loadModule();
    const baseUrl = "/api/sessions/abc/events";
    const unsubscribe = createSSESubscribe({
      baseUrl,
      onEvent: vi.fn(),
    });

    // 오류 → pending reconnect 타이머 생성
    instances[0].emitError();
    expect(instances[0].closed).toBe(true);

    // 구독 해제 후 reconnect 지연이 경과해도 새 연결이 만들어지지 않아야 함
    unsubscribe();
    vi.advanceTimersByTime(10000);
    expect(instances).toHaveLength(1);
  });

  it("history_sync 이벤트의 last_event_id로 currentLastEventId가 갱신된다 (재연결 시 baseline)", async () => {
    const createSSESubscribe = await loadModule();
    const baseUrl = "/api/sessions/abc/events";
    const onEvent = vi.fn();
    const unsubscribe = createSSESubscribe({ baseUrl, onEvent });

    // history_sync는 SSE id 필드 없이 (lastEventId=0) payload.last_event_id로 baseline 전달
    instances[0].emit(
      "history_sync",
      { type: "history_sync", last_event_id: 99, is_live: true },
      0,
    );

    expect(onEvent).toHaveBeenCalledTimes(1);

    // 재연결 시 history_sync.last_event_id가 currentLastEventId에 반영되어
    // URL에 ?lastEventId=99로 전송되어야 함
    instances[0].emitError();
    vi.advanceTimersByTime(3000);
    expect(instances).toHaveLength(2);
    expect(instances[1].url).toBe(`${baseUrl}?lastEventId=99`);

    unsubscribe();
  });

  it("subscribe URL에 mode 파라미터가 포함되지 않는다 (회귀 가드)", async () => {
    const createSSESubscribe = await loadModule();
    const baseUrl = "/api/sessions/abc/events";
    const unsubscribe = createSSESubscribe({
      baseUrl,
      onEvent: vi.fn(),
      initialLastEventId: 5,
    });

    // mode 파라미터는 양 서버에서 모두 제거됨 — URL에 포함되어선 안 됨
    expect(instances[0].url).not.toContain("mode=");
    expect(instances[0].url).toBe(`${baseUrl}?lastEventId=5`);

    unsubscribe();
  });

  it("서버가 named 'error' 이벤트(MessageEvent)를 보내면 재연결하지 않는다", async () => {
    const createSSESubscribe = await loadModule();
    const baseUrl = "/api/sessions/abc/events";
    const onStatusChange = vi.fn();
    const unsubscribe = createSSESubscribe({
      baseUrl,
      onEvent: vi.fn(),
      onStatusChange,
    });

    // 서버가 보낸 것처럼 MessageEvent 인스턴스를 전달
    const messageEvent = new MessageEvent("error", {
      data: "server-side error payload",
    });
    instances[0].onerror?.(messageEvent);

    // 연결은 유지되어야 함 (close되지 않음)
    expect(instances[0].closed).toBe(false);
    // 상태가 "error"로 바뀌지 않아야 함
    expect(onStatusChange).not.toHaveBeenCalledWith("error");

    unsubscribe();
  });
});
