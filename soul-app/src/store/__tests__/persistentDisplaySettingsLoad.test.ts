import { useChatStore } from '../chatStore';

test('같은 세션 재조회는 표시를 보존하고 요청 id가 지난 응답과 저장 이전 응답을 버린다', () => {
  useChatStore.getState().clearPersistentDisplaySettings();
  const state = useChatStore.getState();
  const settings = { show_character: false, animate_character: true, show_turn_usage: false,
    show_generation_separator: true, show_jev_candidates: false };
  const first = state.beginPersistentDisplaySettingsLoad('pas-1');
  state.finishPersistentDisplaySettingsLoad('pas-1', first, settings);
  const second = state.beginPersistentDisplaySettingsLoad('pas-1');
  expect(second).toBe(first + 1);
  expect(useChatStore.getState().persistentDisplaySettings?.settings).toEqual(settings);
  state.finishPersistentDisplaySettingsLoad('pas-1', first, null);
  expect(useChatStore.getState().persistentDisplaySettings?.settings).toEqual(settings);
  state.applyPersistentDisplaySettings('pas-1', { ...settings, show_character: true });
  state.finishPersistentDisplaySettingsLoad('pas-1', second, settings);
  expect(useChatStore.getState().persistentDisplaySettings?.settings?.show_character).toBe(true);
  const third = state.beginPersistentDisplaySettingsLoad('pas-2');
  expect(useChatStore.getState().persistentDisplaySettings?.settings).toBeNull();
  state.clearPersistentDisplaySettings('pas-1');
  expect(useChatStore.getState().persistentDisplaySettings?.sessionId).toBe('pas-2');
  state.clearPersistentDisplaySettings('pas-2');
  state.finishPersistentDisplaySettingsLoad('pas-2', third, settings);
  expect(useChatStore.getState().persistentDisplaySettings).toBeNull();
});
