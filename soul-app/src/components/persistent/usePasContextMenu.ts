import { useDisplayPreferenceActions } from '../settings/useDisplayPreferenceActions';
import { showAppContextMenu } from '../menus/AppContextMenu';
import { usePersistentSessionScene } from '../../navigation/PersistentSessionContext';
import { useTokens } from '../../theme';

export function usePasContextMenu(onHome?: () => void) {
  const session = usePersistentSessionScene(state => state.session);
  const setSettingsOpen = usePersistentSessionScene(state => state.setSettingsOpen);
  const { handleAppearanceChange } = useDisplayPreferenceActions();
  const t = useTokens();
  return () => showAppContextMenu([
    ...(onHome ? [{ key: 'home', label: '홈으로 돌아가기', onSelect: onHome }] : []),
    { key: 'appearance', label: '밝기 전환', onSelect: () => handleAppearanceChange(t.mode === 'light' ? 'dark' : 'light') },
    { key: 'settings', label: '영구 세션 설정', onSelect: () => setSettingsOpen(true) },
  ], session?.agent_name ?? undefined);
}
