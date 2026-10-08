import { useChatStore } from '../chatStore';

test('표시 설정 조회와 정리는 세션별로 독립하고 같은 세션의 지난 응답은 무시한다', () => {
  useChatStore.getState().clearPersistentDisplaySettings();
  const state = useChatStore.getState();
  const pasSettings = { show_character: false, animate_character: true, turn_usage_mode: 'hidden' as const,
    show_generation_separator: true, show_jev_candidates: false };
  const assignedSettings = { show_character: true, animate_character: false, turn_usage_mode: 'collapsed' as const,
    show_generation_separator: false, show_jev_candidates: true };

  const pasFirstRequest = state.beginPersistentDisplaySettingsLoad('pas-1');
  state.finishPersistentDisplaySettingsLoad('pas-1', pasFirstRequest, pasSettings);
  const pasReload = state.beginPersistentDisplaySettingsLoad('pas-1');
  expect(useChatStore.getState().persistentDisplaySettingsBySession['pas-1']?.settings).toEqual(pasSettings);
  state.finishPersistentDisplaySettingsLoad('pas-1', pasFirstRequest, null);
  expect(useChatStore.getState().persistentDisplaySettingsBySession['pas-1']?.settings).toEqual(pasSettings);

  const assignedRequest = state.beginPersistentDisplaySettingsLoad('assigned-1');
  expect(useChatStore.getState().persistentDisplaySettingsBySession['pas-1']?.settings).toEqual(pasSettings);
  expect(useChatStore.getState().persistentDisplaySettingsBySession['assigned-1']?.settings).toBeNull();
  state.finishPersistentDisplaySettingsLoad('assigned-1', assignedRequest, assignedSettings);
  expect(useChatStore.getState().persistentDisplaySettingsBySession['assigned-1']?.settings).toEqual(assignedSettings);

  state.applyPersistentDisplaySettings('pas-1', { ...pasSettings, show_character: true });
  state.finishPersistentDisplaySettingsLoad('pas-1', pasReload, pasSettings);
  expect(useChatStore.getState().persistentDisplaySettingsBySession['pas-1']?.settings?.show_character).toBe(true);
  expect(useChatStore.getState().persistentDisplaySettingsBySession['assigned-1']?.settings).toEqual(assignedSettings);

  const assignedReload = state.beginPersistentDisplaySettingsLoad('assigned-1');
  state.finishPersistentDisplaySettingsLoad('assigned-1', assignedRequest, null);
  expect(useChatStore.getState().persistentDisplaySettingsBySession['assigned-1']?.settings).toEqual(assignedSettings);
  state.clearPersistentDisplaySettings('pas-1');
  expect(useChatStore.getState().persistentDisplaySettingsBySession['pas-1']).toBeUndefined();
  expect(useChatStore.getState().persistentDisplaySettingsBySession['assigned-1']?.settings).toEqual(assignedSettings);
  state.finishPersistentDisplaySettingsLoad('pas-1', pasReload, null);
  state.clearPersistentDisplaySettings();
  state.finishPersistentDisplaySettingsLoad('assigned-1', assignedReload, null);
  expect(useChatStore.getState().persistentDisplaySettingsBySession).toEqual({});

});
