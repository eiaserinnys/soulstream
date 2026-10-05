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
    const current = state.persistentDisplaySettings;
    return current?.sessionId === SESSION_ID ? current.settings : null;
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
  });
  const candidate = persistentJevCandidatesFixture('42', 'input-40', { selectedCount: 2 });
  const input: SessionEvent = {
    id: '40',
    type: 'user_message',
    data: { input_id: 'input-40', text: '후보를 찾아줘.' },
  };

  const { result } = renderHook(useSessionRenderItems);
  act(() => useChatStore.getState().mergeEvents(SESSION_ID, [candidate]));
  expect(result.current.reversedItems.some(item => item.kind === 'jev-candidates')).toBe(false);

  act(() => useChatStore.getState().mergeEvents(SESSION_ID, [input, candidate]));
  let items = [...result.current.reversedItems].reverse();
  expect(items.map(item => item.kind)).toEqual(['event', 'jev-candidates']);
  expect(items[1]).toMatchObject({ kind: 'jev-candidates', anchorEventId: 40 });

  act(() => useChatStore.getState().mergeEvents(SESSION_ID, [input, candidate]));
  expect(useChatStore.getState().eventsBySession[SESSION_ID]).toHaveLength(2);
  expect(result.current.reversedItems.filter(item => item.kind === 'jev-candidates')).toHaveLength(1);

  act(() => useChatStore.getState().applyPersistentDisplaySettings(SESSION_ID, {
    show_generation_separator: true,
    show_jev_candidates: false,
  }));
  items = [...result.current.reversedItems].reverse();
  expect(items.map(item => item.kind)).toEqual(['event']);

  act(() => useChatStore.getState().applyPersistentDisplaySettings(SESSION_ID, {
    show_generation_separator: true,
    show_jev_candidates: true,
  }));
  items = [...result.current.reversedItems].reverse();
  expect(items.map(item => item.kind)).toEqual(['event', 'jev-candidates']);
  expect(useChatStore.getState().eventsBySession[SESSION_ID]).toHaveLength(2);

  act(() => {
    useChatStore.getState().clearSession(SESSION_ID);
    useChatStore.getState().clearPersistentDisplaySettings(SESSION_ID);
  });
});
