import { act, renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { persistentJevCandidatesFixture } from '../../../component-review/persistentJevCandidatesFixture';
import { useChatStore } from '../../../store/chatStore';
import { useChatRenderItems } from '../useChatRenderItems';

const SESSION_ID = 'persistent-display-store-projection';
const EMPTY_EVENTS: SessionEvent[] = [];

function useSessionRenderItems() {
  const events = useChatStore(state => state.eventsBySession[SESSION_ID] ?? EMPTY_EVENTS);
  const settings = useChatStore(state => {
    return state.persistentDisplaySettingsBySession[SESSION_ID]?.settings ?? null;
  });
  return useChatRenderItems({
    events,
    pendingOptimistic: undefined,
    streamingSlots: undefined,
    sessionStatus: 'completed',
    persistentDisplaySettings: settings ? {
      showGenerationSeparator: settings.show_generation_separator,
      showJevCandidates: settings.show_jev_candidates,
    } : undefined,
  });
}

test('store raw Jev record waits for history input, deduplicates replay, and follows display toggles through the render hook', () => {
  const store = useChatStore.getState();
  const requestId = store.beginPersistentDisplaySettingsLoad(SESSION_ID);
  store.finishPersistentDisplaySettingsLoad(SESSION_ID, requestId, {
    show_generation_separator: true,
    show_jev_candidates: true,
    turn_usage_mode: 'collapsed',
  });
  const candidate = persistentJevCandidatesFixture('42', 'input-40', { selectedCount: 2 });
  const assignedContext: SessionEvent = {
    id: '43',
    type: 'debug',
    data: {
      kind: 'assigned_card_context_snapshot',
      content: '담당 카드 입력 준비',
      capture: {
        source: 'prepared_model_input',
        identityMissing: false,
        registrationId: 'registration-40',
        executionCommandId: 'command-40',
        inputId: 'input-40',
        snapshot: {
          capturedAt: '2026-10-02T01:00:00.000Z',
          cards: [{ title: '담당 카드', status: 'running', latestReportAt: null }],
        },
      },
    },
  };
  const input: SessionEvent = {
    id: '40',
    type: 'user_message',
    data: { input_id: 'input-40', text: '후보를 찾아줘.' },
  };

  const { result } = renderHook(useSessionRenderItems);
  act(() => useChatStore.getState().mergeEvents(SESSION_ID, [assignedContext, candidate]));
  expect(result.current.reversedItems.some(item => item.kind === 'jev-candidates' || item.kind === 'turn-summary')).toBe(false);

  act(() => useChatStore.getState().mergeEvents(SESSION_ID, [input, assignedContext, candidate]));
  let items = [...result.current.reversedItems].reverse();
  expect(items.map(item => item.kind)).toEqual(['event', 'jev-candidates', 'turn-summary']);
  expect(items.map(item => item.key)).toEqual(['evt-40', 'jev-candidates-42', 'turn-summary-43']);
  expect(items[1]).toMatchObject({ kind: 'jev-candidates', anchorEventId: 40 });
  expect(items[2]).toMatchObject({ kind: 'turn-summary', key: 'turn-summary-43', anchorEventId: 40 });

  act(() => useChatStore.getState().mergeEvents(SESSION_ID, [input, assignedContext, candidate]));
  expect(useChatStore.getState().eventsBySession[SESSION_ID]).toHaveLength(3);
  expect(result.current.reversedItems.filter(item => item.kind === 'jev-candidates')).toHaveLength(1);
  expect(result.current.reversedItems.filter(item => item.kind === 'turn-summary')).toHaveLength(1);

  act(() => useChatStore.getState().applyPersistentDisplaySettings(SESSION_ID, {
    show_generation_separator: true,
    show_jev_candidates: false,
    turn_usage_mode: 'collapsed',
  }));
  items = [...result.current.reversedItems].reverse();
  expect(items.map(item => item.kind)).toEqual(['event', 'turn-summary']);
  expect(items.map(item => item.key)).toEqual(['evt-40', 'turn-summary-43']);

  act(() => useChatStore.getState().applyPersistentDisplaySettings(SESSION_ID, {
    show_generation_separator: true,
    show_jev_candidates: true,
    turn_usage_mode: 'collapsed',
  }));
  items = [...result.current.reversedItems].reverse();
  expect(items.map(item => item.kind)).toEqual(['event', 'jev-candidates', 'turn-summary']);
  expect(items.map(item => item.key)).toEqual(['evt-40', 'jev-candidates-42', 'turn-summary-43']);
  expect(useChatStore.getState().eventsBySession[SESSION_ID]).toHaveLength(3);

  act(() => {
    useChatStore.getState().clearSession(SESSION_ID);
    useChatStore.getState().clearPersistentDisplaySettings(SESSION_ID);
  });
});
