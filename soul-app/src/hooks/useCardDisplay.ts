import { useSettingsStore } from '../store/settingsStore';
import { useCallback } from 'react';
import type { FolderCardDisplay } from '../components/planner/CardBoardWorkspace';

/** Local view preference, shared by phone/tablet without a server contract. */
export function useCardDisplay(folderId?: string): FolderCardDisplay {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const scope = JSON.stringify([serverUrl, folderId ?? null]);
  const includeCompleted = useSettingsStore((state) => state.cardIncludeCompleted[scope] ?? false);
  const setIncludeCompleted = useSettingsStore((state) => state.setCardIncludeCompleted);
  const onChange = useCallback((value: boolean) => setIncludeCompleted(scope, value), [scope, setIncludeCompleted]);
  return { includeCompleted, onChange };
}
