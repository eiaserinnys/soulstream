import type { SSEEventPayload } from "../protocol.js";
import { mapAppServerNotification } from "./event_mapper.js";
import type {
  AppServerNotification,
  AppServerTurn,
} from "./protocol.js";

export interface ActiveTurnState {
  threadId: string;
  turnId: string;
}

export interface NotificationLifecycleState {
  readonly executionThreadId: string | null;
  readonly activeTurn: ActiveTurnState | null;
  readonly emittedSessionIds: ReadonlySet<string>;
  readonly reportedSessionIds: ReadonlySet<string>;
}

export interface NotificationLifecycleResult {
  state: NotificationLifecycleState;
  payloads: SSEEventPayload[];
  closeQueue: boolean;
}

export interface ThreadOpenedResult {
  state: NotificationLifecycleState;
  emitSession: boolean;
  reportSession: boolean;
}

export interface TurnStartResponseResult {
  state: NotificationLifecycleState;
  closeQueue: boolean;
}

export function createNotificationLifecycleState(): NotificationLifecycleState {
  return {
    executionThreadId: null,
    activeTurn: null,
    emittedSessionIds: new Set<string>(),
    reportedSessionIds: new Set<string>(),
  };
}

export function beginNotificationExecution(
  state: NotificationLifecycleState,
  threadId: string,
): NotificationLifecycleState {
  return {
    ...state,
    executionThreadId: threadId,
    activeTurn: null,
  };
}

export function recordThreadOpened(
  state: NotificationLifecycleState,
  threadId: string,
): ThreadOpenedResult {
  const emitSession = !state.emittedSessionIds.has(threadId);
  const reportSession = !state.reportedSessionIds.has(threadId);
  if (!emitSession && !reportSession) {
    return { state, emitSession, reportSession };
  }

  return {
    state: {
      ...state,
      emittedSessionIds: emitSession
        ? new Set([...state.emittedSessionIds, threadId])
        : state.emittedSessionIds,
      reportedSessionIds: reportSession
        ? new Set([...state.reportedSessionIds, threadId])
        : state.reportedSessionIds,
    },
    emitSession,
    reportSession,
  };
}

export function recordTurnStartResponse(
  state: NotificationLifecycleState,
  threadId: string,
  turn: AppServerTurn,
): TurnStartResponseResult {
  if (state.executionThreadId !== threadId) {
    return { state, closeQueue: false };
  }
  if (turn.status !== "inProgress") {
    return {
      state: clearNotificationExecution(state),
      closeQueue: true,
    };
  }

  return {
    state: setActiveTurn(state, { threadId, turnId: turn.id }),
    closeQueue: false,
  };
}

export function clearNotificationExecution(
  state: NotificationLifecycleState,
): NotificationLifecycleState {
  if (state.executionThreadId === null && state.activeTurn === null) return state;
  return { ...state, executionThreadId: null, activeTurn: null };
}

export function applyNotificationLifecycle(
  state: NotificationLifecycleState,
  notification: AppServerNotification,
  options: { suppressThreadStartedSession: boolean },
): NotificationLifecycleResult {
  if (!belongsToNotificationExecution(state, notification)) {
    return { state, payloads: [], closeQueue: false };
  }

  let nextState = state;

  if (notification.method === "turn/started") {
    const params = notification.params as { threadId: string; turn: { id: string } };
    nextState = setActiveTurn(nextState, {
      threadId: params.threadId,
      turnId: params.turn.id,
    });
  }

  if (notification.method === "thread/started") {
    const params = notification.params as { thread: { id: string } };
    const sessionId = params.thread.id;
    if (
      options.suppressThreadStartedSession ||
      nextState.emittedSessionIds.has(sessionId)
    ) {
      return { state: nextState, payloads: [], closeQueue: false };
    }
    nextState = {
      ...nextState,
      emittedSessionIds: new Set([...nextState.emittedSessionIds, sessionId]),
    };
  }

  const payloads = mapAppServerNotification(notification);

  if (notification.method === "turn/completed") {
    return {
      state: clearNotificationExecution(nextState),
      payloads,
      closeQueue: true,
    };
  }

  if (
    notification.method === "error" &&
    (notification.params as { willRetry?: boolean }).willRetry !== true
  ) {
    return {
      state: clearNotificationExecution(nextState),
      payloads,
      closeQueue: true,
    };
  }

  return { state: nextState, payloads, closeQueue: false };
}

function belongsToNotificationExecution(
  state: NotificationLifecycleState,
  notification: AppServerNotification,
): boolean {
  const { threadId, turnId } = notificationIdentity(notification);

  if (threadId !== undefined) {
    if (state.executionThreadId === null || threadId !== state.executionThreadId) {
      return false;
    }
  }

  if (turnId === undefined) return true;

  if (notification.method === "turn/started") {
    return state.activeTurn === null || turnId === state.activeTurn.turnId;
  }

  return state.activeTurn !== null && turnId === state.activeTurn.turnId;
}

function notificationIdentity(
  notification: AppServerNotification,
): { threadId?: string; turnId?: string } {
  const params = asRecord(notification.params);
  let threadId = stringField(params, "threadId");
  let turnId = stringField(params, "turnId");

  if (notification.method === "thread/started") {
    threadId = stringField(asRecord(params?.thread), "id");
  } else if (
    notification.method === "turn/started" ||
    notification.method === "turn/completed"
  ) {
    turnId = stringField(asRecord(params?.turn), "id");
  }

  return { threadId, turnId };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function setActiveTurn(
  state: NotificationLifecycleState,
  activeTurn: ActiveTurnState,
): NotificationLifecycleState {
  if (
    state.activeTurn?.threadId === activeTurn.threadId &&
    state.activeTurn.turnId === activeTurn.turnId
  ) {
    return state;
  }
  return { ...state, activeTurn };
}
