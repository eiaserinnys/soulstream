import { useMemo } from 'react';
import type { ApiClient } from '../../api/client';
import type { PlannerFolder } from '../../api/plannerTypes';
import { operationId, type FolderCreationAttempt } from '../../api/plannerMutationPort';
import type { InitialFolderContext } from '../../api/initialFolderContext';
import { captureAuthScope, isAuthScopeCurrent } from '../../lib/auth-scope';
import { folderContextOperations, type FolderSettingsDraft } from '../../lib/folder-settings';
import { usePlannerActions } from '../../hooks/usePlannerActions';
import { usePlannerStore } from '../../store/plannerStore';
import { useSessionStore } from '../../store/sessionStore';

export interface FolderCreateInput {
  title: string;
  description: string;
  /** Parent folder; null creates a top-level folder. */
  folderId: string | null;
  projectPageId: string | null;
  initialContext: InitialFolderContext;
  creation?: FolderCreationAttempt;
}

export interface FolderSaveInput {
  folder: PlannerFolder;
  baseline: FolderSettingsDraft;
  draft: FolderSettingsDraft;
}

/** Create and save paths of the folder settings sheet. Both write everything in one confirm. */
export function useFolderSettingsActions(api: ApiClient | null) {
  const actions = usePlannerActions(api);
  return useMemo(() => ({
    createFolder: async (input: FolderCreateInput) => {
      if (input.folderId && input.projectPageId) {
        return actions.createFolder({ ...input, folderId: input.folderId, projectPageId: input.projectPageId });
      }
      if (!api) throw new Error('서버에 연결되어 있지 않습니다.');
      const scope = captureAuthScope();
      const result = await api.plannerMutations.createFolder({ ...input, folderId: null });
      if (isAuthScopeCurrent(scope)) {
        const catalog = useSessionStore.getState().catalog;
        useSessionStore.setState({ catalog: {
          ...catalog,
          folders: [...catalog.folders.filter((folder) => folder.id !== result.folder.id), result.folder],
        } });
        usePlannerStore.getState().invalidate('folder');
      }
      return result;
    },
    saveFolderSettings: async ({ folder, baseline, draft }: FolderSaveInput) => {
      if (!api) throw new Error('서버에 연결되어 있지 않습니다.');
      const scope = captureAuthScope();
      const title = draft.title.trim();
      if (!title) throw new Error('이름을 입력해 주세요.');
      if (title !== baseline.title.trim()) await actions.renameFolder(folder.folderId, title);
      if (draft.description !== baseline.description) await actions.saveFolderDescription(folder, draft.description);
      const current = await api.getPage(folder.page.id);
      const operations = folderContextOperations(current.blocks, draft, operationId);
      if (operations.length > 0) {
        await api.applyPageOperations(folder.page.id, {
          expectedVersion: current.page.version,
          expectedStateVector: current.stateVector,
          idempotencyKey: operationId('folder-settings'),
          reason: 'soul-app folder settings save',
          operations,
        });
      }
      if (isAuthScopeCurrent(scope)) usePlannerStore.getState().invalidate('page');
    },
  }), [actions, api]);
}
