import { renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { useChatSseStream } from '../useChatSseStream';

let mockScopeGeneration = 'scope-i2';
jest.mock('../../../lib/auth-scope', () => ({
  captureAuthScope: () => ({
    serverUrl: 'https://example.test',
    jwt: null,
    generation: mockScopeGeneration,
  }),
  isAuthScopeCurrent: (scope: { generation: string }) =>
    scope.generation === mockScopeGeneration,
  clearAuthForScope: jest.fn(),
  subscribeAuthScope: () => jest.fn(),
  useAuthScopeGeneration: () => mockScopeGeneration,
}));

declare global {
  // jest.setup.js의 react-native-sse mock이 노출하는 인스턴스.
  // eslint-disable-next-line no-var
  var __lastSSEInstance: any;
}

const SESSION_ID = 'session-i2';
const INTERVENTION_NONCE = 'i2-intervention-593';
const REPLACEMENT_REPLY_NONCE = 'i2-replacement-reply-598';
const FOLLOWUP_NONCE = 'i2-followup-606';
const FOLLOWUP_REPLY_NONCE = 'i2-followup-reply-607';

interface VisibilityObservation {
  streamClosed: boolean;
  interventionInputs: number;
  cancellationErrors: number;
  replacementReplies: number;
  followupInputs: number;
  followupReplies: number;
  terminalEvents: number;
}

function visibilityViolations(observation: VisibilityObservation): string[] {
  const violations: string[] = [];
  if (observation.streamClosed) violations.push('semantic_error_closed_stream');
  if (observation.interventionInputs !== 1) violations.push('intervention_not_visible_once');
  if (observation.cancellationErrors !== 1) violations.push('cancellation_error_not_visible_once');
  if (observation.replacementReplies !== 1) violations.push('replacement_reply_not_visible_once');
  if (observation.followupInputs !== 1) violations.push('followup_input_not_visible_once');
  if (observation.followupReplies !== 1) violations.push('followup_reply_not_visible_once');
  if (observation.terminalEvents !== 0) violations.push('session_became_terminal');
  return violations;
}

function visibleCount(
  events: readonly SessionEvent[],
  type: SessionEvent['type'],
  nonce: string,
): number {
  return events.filter((event) => {
    if (event.type !== type) return false;
    return Object.values(event.data).some((value) => value === nonce);
  }).length;
}

function renderVisibilitySubject() {
  const visibleEvents: SessionEvent[] = [];
  const isCatchingUpRef = { current: true };
  const historyLoadingRef = { current: false };
  const pendingLiveQueueRef = {
    current: [] as Array<{ event: SessionEvent; eid: string }>,
  };
  const pendingCatchupQueueRef = {
    current: [] as Array<{ event: SessionEvent; eid: string }>,
  };
  const api = {
    sessionEventsUrl: () => 'https://example.test/api/sessions/session-i2/events',
  };

  const hook = renderHook(() =>
    useChatSseStream({
      api: api as never,
      sessionId: SESSION_ID,
      active: true,
      scopeGeneration: mockScopeGeneration,
      isCatchingUpRef,
      historyLoadingRef,
      pendingLiveQueueRef,
      pendingCatchupQueueRef,
      resetToSnapshot: jest.fn(),
      mergeEvents: (_sessionId, events) => visibleEvents.push(...events),
      setLastEventId: jest.fn(),
      setStreamingEvent: jest.fn(),
      replaceAssistantStreamingEvents: jest.fn(),
      clearStreamingEvent: jest.fn(),
      finalizeStreamingEvent: jest.fn(),
      applyClaudeRuntimeEvent: jest.fn(),
      streamFailureRef: { current: jest.fn() },
    }),
  );

  const stream = globalThis.__lastSSEInstance;
  stream.triggerOpen();
  stream.triggerEvent('history_sync', {
    type: 'history_sync',
    last_event_id: 592,
    is_live: true,
  });
  return { ...hook, stream, visibleEvents };
}

beforeEach(() => {
  mockScopeGeneration = 'scope-i2';
});

test('ideal intervention visibility observation has no violations', () => {
  expect(visibilityViolations({
    streamClosed: false,
    interventionInputs: 1,
    cancellationErrors: 1,
    replacementReplies: 1,
    followupInputs: 1,
    followupReplies: 1,
    terminalEvents: 0,
  })).toEqual([]);
});

test('control: ordinary completion remains visible exactly once', () => {
  const { stream, visibleEvents, unmount } = renderVisibilitySubject();
  stream.triggerEvent('user_message', {
    type: 'user_message',
    text: FOLLOWUP_NONCE,
  }, '700');
  stream.triggerEvent('assistant_message', {
    type: 'assistant_message',
    content: FOLLOWUP_REPLY_NONCE,
  }, '701');

  expect(stream.closed).toBe(false);
  expect(visibleCount(visibleEvents, 'user_message', FOLLOWUP_NONCE)).toBe(1);
  expect(visibleCount(visibleEvents, 'assistant_message', FOLLOWUP_REPLY_NONCE)).toBe(1);
  unmount();
});

test('canceled attempt error does not hide nonce replacement and followup replies', () => {
  jest.useFakeTimers();
  const { stream, visibleEvents, unmount } = renderVisibilitySubject();
  try {
    stream.triggerEvent('text_start', {
      type: 'text_start',
      message_id: 'long-reply-before-intervention',
      _live_only: true,
    });
    stream.triggerEvent('intervention_sent', {
      type: 'intervention_sent',
      text: INTERVENTION_NONCE,
    }, '593');
    stream.triggerEvent('error', {
      type: 'error',
      fatal: false,
      message: '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null',
      error_code: 'error_during_execution',
    }, '595');
    stream.triggerEvent('assistant_message', {
      type: 'assistant_message',
      content: REPLACEMENT_REPLY_NONCE,
    }, '598');
    stream.triggerEvent('user_message', {
      type: 'user_message',
      text: FOLLOWUP_NONCE,
    }, '606');
    stream.triggerEvent('assistant_message', {
      type: 'assistant_message',
      content: FOLLOWUP_REPLY_NONCE,
    }, '607');

    const observation: VisibilityObservation = {
      streamClosed: stream.closed === true,
      interventionInputs: visibleCount(
        visibleEvents,
        'intervention_sent',
        INTERVENTION_NONCE,
      ),
      cancellationErrors: visibleCount(
        visibleEvents,
        'error',
        '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null',
      ),
      replacementReplies: visibleCount(
        visibleEvents,
        'assistant_message',
        REPLACEMENT_REPLY_NONCE,
      ),
      followupInputs: visibleCount(visibleEvents, 'user_message', FOLLOWUP_NONCE),
      followupReplies: visibleCount(
        visibleEvents,
        'assistant_message',
        FOLLOWUP_REPLY_NONCE,
      ),
      terminalEvents: visibleEvents.filter((event) => event.type === 'session_ended').length,
    };

    process.stdout.write(`I2_INTERVENTION_VISIBILITY_RED ${JSON.stringify(visibilityViolations(observation))}\n`);
    expect(visibilityViolations(observation)).toEqual([]);
  } finally {
    unmount();
    jest.useRealTimers();
  }
});
