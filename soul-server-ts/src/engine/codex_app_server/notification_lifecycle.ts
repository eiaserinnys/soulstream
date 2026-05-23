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
    activeTurn: null,
    emittedSessionIds: new Set<string>(),
    reportedSessionIds: new Set<string>(),
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
  if (turn.status !== "inProgress") {
    return {
      state: clearActiveTurn(state),
      closeQueue: true,
    };
  }

  return {
    state: setActiveTurn(state, { threadId, turnId: turn.id }),
    closeQueue: false,
  };
}

export function clearActiveTurn(
  state: NotificationLifecycleState,
): NotificationLifecycleState {
  if (state.activeTurn === null) return state;
  return { ...state, activeTurn: null };
}

export function applyNotificationLifecycle(
  state: NotificationLifecycleState,
  notification: AppServerNotification,
  options: { suppressThreadStartedSession: boolean },
): NotificationLifecycleResult {
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
    const params = notification.params as { turn: { id: string } };
    if (params.turn.id === nextState.activeTurn?.turnId) {
      nextState = clearActiveTurn(nextState);
    }
    return { state: nextState, payloads, closeQueue: true };
  }

  if (
    notification.method === "error" &&
    (notification.params as { willRetry?: boolean }).willRetry !== true
  ) {
    return {
      state: clearActiveTurn(nextState),
      payloads,
      closeQueue: true,
    };
  }

  return { state: nextState, payloads, closeQueue: false };
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
