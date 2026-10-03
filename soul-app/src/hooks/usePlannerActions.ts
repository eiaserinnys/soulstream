import { useMemo } from 'react';
import type { ApiClient } from '../api/client';
import type { InitialFolderContext } from '../api/initialFolderContext';
import { toSession } from '../api/mappers';
import type { PageReadResult } from '../api/pageEndpoints';
import type {
  PlannerBlock,
  PlannerPage,
  PlannerFolder,
} from '../api/plannerTypes';
import { requirePlannerFolderId } from '../api/plannerFolderIdentity';
import {
  mergeDailyPageProjection,
  patchDailyMemoProjection,
} from '../lib/planner-daily-projection';
import {
  acknowledgeFolderSessionProjection,
  addFolderSessionProjection,
  capturePlannerProjection,
  completeFolderProjection,
  deleteFolderSessionProjection,
  insertFolderProjection,
  moveFolderParentProjection,
  moveFolderSessionProjection,
  patchProjectPageProjection,
  patchFolderBlocksProjection,
  removeFolderProjection,
  renameFolderSessionProjection,
  replaceFolderProjection,
  setFolderDailyMembership,
  setFolderStarredProjection,
  type PlannerProjectionState,
} from '../lib/planner-mutation-projection';
import { beginPlannerDescriptionMutation } from '../lib/planner-description-mutation-ownership';
import { capturePlannerDescriptionProjection, patchPlannerDescriptionProjection } from '../lib/planner-description-projection';
import { runPlannerMutationTransaction } from '../lib/planner-mutation-transaction';
import {
  runPlannerPageMutation,
  type PlannerPageMutationInput,
} from '../lib/planner-page-mutation';
import { readPlannerPageIfCurrent } from '../lib/planner-targeted-page-read';
import {
  isPlannerStoreScopeCurrent,
  selectPlannerFolder,
  setPlannerProjectionForScope,
  usePlannerStore,
} from '../store/plannerStore';
import {
  isSessionStoreScopeCurrent,
  setSessionProjectionForScope,
  useSessionStore,
} from '../store/sessionStore';
import {
  pendingId,
  pendingPlannerSession,
  projectDescriptionBlocks,
} from './plannerActionModels';
import { createPlannerCatalogActions } from './plannerCatalogActions';
import { savePlannerSessionDefaults } from '../lib/planner-session-defaults';
import { captureAuthScope, useAuthScopeGeneration } from '../lib/auth-scope';

export function usePlannerActions(api: ApiClient | null, requestedScopeGeneration?: string) {
  const currentScopeGeneration = useAuthScopeGeneration();
  const scopeGeneration = requestedScopeGeneration ?? currentScopeGeneration;
  return useMemo(
    () => createPlannerActions(api, scopeGeneration),
    [api, scopeGeneration],
  );
}

export function createPlannerActions(
  api: ApiClient | null,
  scopeGeneration = captureAuthScope().generation,
) {
  const isCurrent = () => isPlannerStoreScopeCurrent(scopeGeneration)
    && isSessionStoreScopeCurrent(scopeGeneration);
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('인증 범위가 변경되어 이전 폴더 요청을 취소했습니다.');
  };
  const requireApi = () => {
    assertCurrent();
    if (!api) throw new Error('서버 연결을 먼저 설정해 주세요.');
    return api;
  };
  const plannerSnapshot = (): PlannerProjectionState => {
    assertCurrent();
    return capturePlannerProjection(usePlannerStore.getState());
  };
  const applyPlanner = (state: PlannerProjectionState): void => {
    setPlannerProjectionForScope(scopeGeneration, state);
  };
  const markChanged = (source: 'page' | 'folder'): void => {
    if (isCurrent()) usePlannerStore.getState().invalidate(source);
  };
  const mergeFolderPage = (
    pageId: string,
    result: { page: PlannerPage; blocks: PlannerBlock[] } | null,
  ): void => {
    if (!result || !isCurrent()) return;
    const folder = selectPlannerFolder(pageId)(usePlannerStore.getState());
    if (folder) {
      applyPlanner(replaceFolderProjection(plannerSnapshot(), {
        ...folder,
        page: result.page,
        blocks: result.blocks,
      }));
    }
  };
  const targetedPageRead = (client: ApiClient, pageId: string, canApply?: () => boolean,
    reconcile?: (result: PageReadResult) => void,
  ) => readPlannerPageIfCurrent({
    client, pageId, isCurrent, canApply,
    reconcile: reconcile ?? ((page) => mergeFolderPage(pageId, page)),
    onFailure: () => markChanged('page'),
  });
  const pageTransaction = <TResult>(client: ApiClient, pageId: string,
    input: PlannerPageMutationInput<TResult>,
  ) => runPlannerPageMutation({
    capture: plannerSnapshot,
    apply: applyPlanner,
    isCurrent,
    markChanged,
    revalidate: (canApply, reconcile) => targetedPageRead(client, pageId, canApply, reconcile),
  }, input);
  const sessionSnapshot = () => {
    assertCurrent();
    return captureSessionSnapshot();
  };
  const restoreSessionSnapshot = (snapshot: ReturnType<typeof captureSessionSnapshot>) => {
    if (isCurrent()) setSessionProjectionForScope(scopeGeneration, snapshot);
  };
  const sessionTransaction = async <TResult>(
    project: () => void,
    mutate: () => Promise<TResult>,
  ): Promise<TResult> => {
    const plannerBefore = plannerSnapshot();
    const sessionBefore = sessionSnapshot();
    project();
    try {
      return await mutate();
    } catch (error) {
      if (isCurrent()) {
        applyPlanner(plannerBefore);
        restoreSessionSnapshot(sessionBefore);
      }
      throw error;
    }
  };

  return {
    ...createPlannerCatalogActions(requireApi, scopeGeneration),
    createFolder: async (input: {
      title: string;
      description?: string;
      folderId: string;
      projectPageId: string;
      initialContext?: InitialFolderContext;
      dailyDate?: string;
      creation?: import('../api/plannerMutationPort').FolderCreationAttempt;
    }) => {
      const client = requireApi();
      const result = await client.plannerMutations.createFolder({
        ...input,
        description: input.description ?? '',
      });
      if (isCurrent()) {
        const catalog = useSessionStore.getState().catalog;
        useSessionStore.setState({ catalog: {
          ...catalog,
          folders: [...catalog.folders.filter((folder) => folder.id !== result.folder.id), result.folder],
        } });
        markChanged('folder');
      }
      return result;
    },

    completeFolder: (folder: PlannerFolder) => {
      const client = requireApi();
      return pageTransaction(client, folder.page.id, {
        source: 'folder',
        project: (before) => completeFolderProjection(before, folder.page.id),
        mutate: () => client.plannerMutations.completeFolder(folder),
        merge: (result) => {
          const catalog = useSessionStore.getState().catalog;
          useSessionStore.setState({ catalog: {
            ...catalog,
            folders: catalog.folders.map((folder) => folder.id === result.folder.id ? result.folder : folder),
          } });
        },
      });
    },

    setFolderToday: (folder: PlannerFolder, date: string, present: boolean) => {
      const client = requireApi();
      return runPlannerMutationTransaction({
        capture: plannerSnapshot,
        project: (before) => applyPlanner(setFolderDailyMembership(before, date, folder, present)),
        mutate: () => client.plannerMutations.setFolderToday(folder, date, present),
        merge: () => markChanged('page'),
        restore: applyPlanner,
      });
    },

    saveFolderDescription: (folder: PlannerFolder, markdown: string) => {
      const client = requireApi();
      const blocks = projectDescriptionBlocks(folder.blocks, folder.page.id, markdown);
      const optimistic = capturePlannerDescriptionProjection({ page: folder.page, blocks });
      const reconcile = (result: { page: PlannerPage; blocks: PlannerBlock[] }) => applyPlanner(patchPlannerDescriptionProjection(
        plannerSnapshot(), folder.page.id, capturePlannerDescriptionProjection(result),
      ));
      const settlement = beginPlannerDescriptionMutation(scopeGeneration, folder.page.id);
      return pageTransaction(client, folder.page.id, {
        project: (before) => patchPlannerDescriptionProjection(before, folder.page.id, optimistic),
        mutate: () => client.plannerMutations.saveFolderDescription(folder.page.id, markdown),
        merge: (result) => { if (result) reconcile(result); },
        reconcile,
        settlement,
      });
    },

    saveFolderSessionDefaults: async (
      folder: PlannerFolder,
      input: { blockId: string | null; agentId: string; nodeId: string; modelPreset?: string },
    ) => {
      const result = await savePlannerSessionDefaults(requireApi(), folder.page.id, input);
      applyPlanner(patchFolderBlocksProjection(plannerSnapshot(), folder.page.id, result.blocks));
      markChanged('page');
      return result;
    },

    saveDailyMemo: (
      date: string,
      dailyPageId: string,
      blockId: string | null,
      text: string,
    ) => {
      const client = requireApi();
      return runPlannerMutationTransaction({
        capture: plannerSnapshot,
        project: (before) => applyPlanner(patchDailyMemoProjection(before, date, blockId, text)),
        mutate: () => client.plannerMutations.saveDailyMemo(dailyPageId, blockId, text),
        merge: (result) => {
          if (result) applyPlanner(mergeDailyPageProjection(
            plannerSnapshot(),
            date,
            result.page,
            result.blocks,
          ));
          markChanged('page');
        },
        restore: applyPlanner,
        revalidate: () => targetedPageRead(client, dailyPageId),
      });
    },

    setFolderStarred: (folder: PlannerFolder, starred: boolean) => {
      const client = requireApi();
      return pageTransaction(client, folder.page.id, {
        project: (before) => setFolderStarredProjection(before, folder.page.id, starred),
        mutate: () => client.plannerMutations.setFolderStarred(folder.page.id, starred),
        merge: (result) => mergeFolderPage(folder.page.id, result),
      });
    },

    moveFolderParent: async (
      folder: PlannerFolder,
      target: { folderId: string; projectPageId: string },
    ) => {
      const client = requireApi();
      const result = await client.plannerMutations.moveFolderParent(folder, target);
      if (isCurrent()) {
        const catalog = useSessionStore.getState().catalog;
        useSessionStore.setState({ catalog: {
          ...catalog,
          folders: catalog.folders.map((folder) => folder.id === result.folder.id ? result.folder : folder),
        } });
        markChanged('folder');
      }
      return result;
    },

    saveProjectContext: (projectPageId: string, markdown: string) => {
      const client = requireApi();
      const project = usePlannerStore.getState().folderByPageId[projectPageId];
      const optimistic = project
        ? { ...project.project, updatedAt: new Date().toISOString() }
        : null;
      return pageTransaction(client, projectPageId, {
        project: (before) => optimistic
          ? patchProjectPageProjection(before, projectPageId, optimistic)
          : before,
        mutate: () => client.plannerMutations.saveProjectContext(projectPageId, markdown),
        merge: (result) => {
          if (result) applyPlanner(patchProjectPageProjection(
            plannerSnapshot(),
            projectPageId,
            result.page,
          ));
        },
      });
    },

    createFolderSession: async (input: {
      folder: PlannerFolder;
      prompt: string;
      nodeId?: string;
      agentId?: string;
      modelPreset?: string;
      reasoningEffort?: string;
      predecessorSessionId?: string;
      needsPageAnchor?: boolean;
      extraContextItems?: Array<{ key: string; label: string; content: unknown }>;
      attachmentPaths?: string[];
    }) => {
      const client = requireApi();
      requirePlannerFolderId(input.folder);
      const anchor = input.needsPageAnchor === false
        ? undefined
        : await client.plannerMutations.createPageAnchor(input.folder.page.id);
      if (anchor) markChanged('page');
      const tempId = pendingId('session');
      const pending = pendingPlannerSession(tempId, input);
      const sessionBefore = sessionSnapshot();
      return runPlannerMutationTransaction({
        capture: plannerSnapshot,
        project: (before) => {
          applyPlanner(addFolderSessionProjection(before, input.folder.page.id, pending));
          useSessionStore.getState().upsertSession(toSession({
            agentSessionId: tempId,
            displayName: null,
            status: 'pending',
            prompt: input.prompt,
            nodeId: input.nodeId, agentId: input.agentId,
            modelPreset: input.modelPreset,
          }));
        },
        mutate: () => client.plannerMutations.createFolderSession({ ...input, pageAnchor: anchor }),
        merge: (response) => {
          const sessionId = response.agentSessionId;
          if (!sessionId) throw new Error('세션 생성 응답에 ID가 없습니다.');
          let next = deleteFolderSessionProjection(plannerSnapshot(), tempId);
          next = addFolderSessionProjection(next, input.folder.page.id, {
            ...pending,
            agentSessionId: sessionId,
          });
          applyPlanner(next);
          useSessionStore.getState().deleteSession(tempId);
          useSessionStore.getState().upsertSession(toSession({
            ...response,
            prompt: input.prompt,
            agentId: input.agentId, modelPreset: input.modelPreset,
            status: 'pending',
          }));
        },
        restore: (before) => {
          applyPlanner(before);
          restoreSessionSnapshot(sessionBefore);
        },
      });
    },

    renameFolderSession: (sessionId: string, displayName: string | null) =>
      sessionTransaction(
        () => {
          applyPlanner(renameFolderSessionProjection(plannerSnapshot(), sessionId, displayName));
          useSessionStore.getState().updateSession(sessionId, { displayName });
        },
        () => requireApi().plannerMutations.renameFolderSession(sessionId, displayName),
      ),

    deleteFolderSession: (sessionId: string) => sessionTransaction(
      () => {
        applyPlanner(deleteFolderSessionProjection(plannerSnapshot(), sessionId));
        useSessionStore.getState().deleteSession(sessionId);
      },
      () => requireApi().plannerMutations.deleteFolderSession(sessionId),
    ),

    moveFolderSession: (sessionId: string, targetFolder: PlannerFolder) => {
      const targetFolderId = requirePlannerFolderId(targetFolder);
      return sessionTransaction(
        () => applyPlanner(moveFolderSessionProjection(
          plannerSnapshot(),
          sessionId,
          targetFolder.page.id,
        )),
        () => requireApi().plannerMutations.moveFolderSession(sessionId, targetFolderId),
      );
    },

    acknowledgeFolderSession: (sessionId: string) => sessionTransaction(
      () => {
        applyPlanner(acknowledgeFolderSessionProjection(plannerSnapshot(), sessionId));
        useSessionStore.getState().updateSession(sessionId, {
          reviewState: 'acknowledged',
          reviewRequired: false,
        });
      },
      () => requireApi().plannerMutations.acknowledgeFolderSession(sessionId),
    ),
  };
}

function captureSessionSnapshot() {
  const state = useSessionStore.getState();
  return {
    sessions: state.sessions,
    catalog: state.catalog,
    catalogReady: state.catalogReady,
    feedSessionIds: state.feedSessionIds,
    sessionChangeSerial: state.sessionChangeSerial,
    lastChangedSessionId: state.lastChangedSessionId,
  };
}
