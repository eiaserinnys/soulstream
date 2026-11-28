import { useMemo } from 'react';
import { create } from 'zustand';
import { createApiClient } from '../../api/client';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { NewFolderSheet } from './NewFolderSheet';
import { useFolderSettingsActions } from './folderSettingsActions';

/** Pending new-folder sheet request; parent page null means a top-level folder. */
export const useFolderCreateRequest = create<{
  parentProjectPageId: string | null | undefined;
  open(parentProjectPageId: string | null): void;
  close(): void;
}>((set) => ({
  parentProjectPageId: undefined,
  open: (parentProjectPageId) => set({ parentProjectPageId }),
  close: () => set({ parentProjectPageId: undefined }),
}));

/** Hosts the new folder sheet for entry points that only hold a callback (header and rail buttons). */
export function FolderCreateSheetHost() {
  const request = useFolderCreateRequest();
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const folders = useSessionStore((state) => state.catalog.folders);
  const actions = useFolderSettingsActions(api);
  return <NewFolderSheet
    visible={request.parentProjectPageId !== undefined}
    api={api}
    folders={folders}
    target={{ kind: 'create', parentProjectPageId: request.parentProjectPageId ?? null }}
    onClose={request.close}
    onSubmit={actions.createFolder}
  />;
}
