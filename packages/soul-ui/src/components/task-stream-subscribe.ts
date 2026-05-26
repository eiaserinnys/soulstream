const TASK_STREAM_EVENT_TYPES = [
  "stream_meta",
  "task_list",
  "task_changed",
  "replay_gap",
] as const;

type TaskStreamEventType = (typeof TASK_STREAM_EVENT_TYPES)[number];
type TaskStreamPayload = Record<string, unknown>;

export interface TaskStreamSubscribeOptions {
  buildUrl: () => string;
  onEvent: (eventType: TaskStreamEventType, data: TaskStreamPayload, event: MessageEvent) => void;
  onStatusChange?: (status: "connecting" | "connected" | "error") => void;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

function parseTaskStreamPayload(event: MessageEvent): TaskStreamPayload {
  try {
    const parsed = JSON.parse(event.data || "{}");
    return parsed && typeof parsed === "object" ? parsed as TaskStreamPayload : {};
  } catch {
    return {};
  }
}

export function createTaskStreamSubscribe(options: TaskStreamSubscribeOptions): () => void {
  const {
    buildUrl,
    onEvent,
    onStatusChange,
    reconnectDelayMs = 3000,
    maxReconnectDelayMs = 30000,
  } = options;
  let closed = false;
  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    const delay = Math.min(
      reconnectDelayMs * Math.pow(2, reconnectAttempt),
      maxReconnectDelayMs,
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (closed || eventSource) return;
    onStatusChange?.("connecting");
    const es = new EventSource(buildUrl());
    eventSource = es;

    const markConnected = () => {
      reconnectAttempt = 0;
      onStatusChange?.("connected");
    };

    es.onopen = markConnected;
    for (const eventType of TASK_STREAM_EVENT_TYPES) {
      es.addEventListener(eventType, (event: MessageEvent) => {
        markConnected();
        onEvent(eventType, parseTaskStreamPayload(event), event);
      });
    }

    es.onerror = () => {
      if (closed || eventSource !== es) return;
      onStatusChange?.("error");
      es.close();
      eventSource = null;
      scheduleReconnect();
    };
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}
