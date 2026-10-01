import React from 'react';
import { cleanup } from '@testing-library/react-native';
import type { FlatList } from 'react-native';
import type { ChatRenderItem } from '../groupChatEvents';
import type { MessagesResponse, HistoricalMessage } from '../../../api/client';
import type { SessionEvent } from '../../../api/types';
import {
  captureAuthScope,
  resetAuthScopeForTest,
  type AuthScopeSnapshot,
} from '../../../lib/auth-scope';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';

export const SID_A = 'sess-a';
export const SID_B = 'sess-b';

export function makeHistoricalMessage(id: number, eventType = 'user_message'): HistoricalMessage {
  return {
    id,
    parent_event_id: null,
    event_type: eventType,
    payload: { content: `m${id}` },
    created_at: new Date().toISOString(),
  };
}

export function makeApi(getTimelineImpl?: (sid: string, params: any) => Promise<MessagesResponse>) {
  return {
    getTimeline: jest.fn(getTimelineImpl ?? (async () => ({ messages: [], next_cursor: null }))),
  };
}

export function makeFlatListRef(): React.RefObject<FlatList<ChatRenderItem> | null> {
  return {
    current: {
      scrollToOffset: jest.fn(),
      recordInteraction: jest.fn(),
    } as any,
  };
}

export function makeRefs() {
  return {
    pendingLiveQueueRef: { current: [] as Array<{ event: SessionEvent; eid: string }> },
    isCatchingUpRef: { current: true },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function makeDeps(opts: {
  api: ReturnType<typeof makeApi> | null;
  sessionId: string | undefined;
  snapshotGeneration?: number;
  active?: boolean;
  flatListRef?: React.RefObject<FlatList<ChatRenderItem> | null>;
  refs?: ReturnType<typeof makeRefs>;
  mergeEvents?: jest.Mock;
  setLastEventId?: jest.Mock;
  triggerAnimation?: jest.Mock;
  applyStateOnlyEvent?: jest.Mock;
  onInitialPageCommitted?: jest.Mock;
  onAsyncCommitError?: jest.Mock;
  authScope?: AuthScopeSnapshot;
}) {
  const refs = opts.refs ?? makeRefs();
  return {
    api: opts.api as any,
    sessionId: opts.sessionId,
    snapshotGeneration: opts.snapshotGeneration ?? 0,
    active: opts.active ?? true,
    authScope: opts.authScope ?? captureAuthScope(),
    mergeEvents: opts.mergeEvents ?? jest.fn(),
    setLastEventId: opts.setLastEventId ?? jest.fn(),
    flatListRef: opts.flatListRef ?? makeFlatListRef(),
    pendingLiveQueueRef: refs.pendingLiveQueueRef,
    isCatchingUpRef: refs.isCatchingUpRef,
    triggerAnimation: opts.triggerAnimation ?? jest.fn(),
    applyStateOnlyEvent: opts.applyStateOnlyEvent,
    onInitialPageCommitted: opts.onInitialPageCommitted,
    onAsyncCommitError: opts.onAsyncCommitError,
  };
}

let fakeTimersActive = false;

export function useFakeTimersForTest(): void {
  fakeTimersActive = true;
  jest.useFakeTimers();
}

export function resetChatHistoryTestScope(): void {
  useSettingsStore.setState({ serverUrl: 'https://chat-history.test' });
  useAuthStore.setState({ jwt: 'scope-a-jwt' });
  resetAuthScopeForTest();
}

export async function cleanupChatHistoryTest(): Promise<void> {
  cleanup();
  if (fakeTimersActive) {
    await Promise.resolve();
    await Promise.resolve();
    jest.clearAllTimers();
  }
  jest.useRealTimers();
  fakeTimersActive = false;
  jest.clearAllMocks();
}
