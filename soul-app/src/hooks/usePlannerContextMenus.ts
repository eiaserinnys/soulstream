import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as Clipboard from 'expo-clipboard';
import type { ApiClient } from '../api/client';
import type { PlannerFolder } from '../api/plannerTypes';
import type { Folder } from '../api/types';
import { showAppContextMenu } from '../components/menus/AppContextMenu';
import {
  buildProjectContextMenuActions,
  buildSessionContextMenuActions,
  buildFolderContextMenuActions,
  type PlannerContextMenuAction,
  type MenuCapability,
} from '../lib/planner-context-menu-model';
import type { ResumeAfterLimitResponse } from '../api/sessionEndpoints';
import { usePlannerStore } from '../store/plannerStore';
import { useSessionStore } from '../store/sessionStore';
import { useUIStore } from '../store/uiStore';
import { usePlannerActions } from './usePlannerActions';
import { useAuthScopeGeneration } from '../lib/auth-scope';
import { confirmPlannerAction, promptPlannerText } from '../components/planner/plannerNativeUI';
import { showProjectManagement } from '../components/planner/projectManagement';
import { buildFolderMoveTargets } from '../lib/folder-tree';

const EXISTING_RESUME_SCHEDULE_STATUSES = [
  'active',
  'dispatching',
  'firing',
  'orphaned',
];
const RESUME_AFTER_LIMIT_UNAVAILABLE_REASON = '예약 가능 여부를 확인하지 못했습니다.';

export interface SessionSuccessionRequest {
  folder: PlannerFolder;
  predecessorSessionId: string | null;
}

export function usePlannerContextMenus(api: ApiClient | null) {
  const actions = usePlannerActions(api);
  const scopeGeneration = useAuthScopeGeneration();
  const folders = useSessionStore((state) => state.catalog.folders);
  const today = useUIStore((state) => state.todayDate);
  const [sessionSuccession, setSessionSuccession] = useState<SessionSuccessionRequest | null>(null);
  const resumeAfterLimitInFlight = useRef(new Set<string>());
  useEffect(() => setSessionSuccession(null), [scopeGeneration]);

  const openFolderMenu = useCallback((folder: PlannerFolder, onOpen: () => void) => {
    const plannerState = usePlannerStore.getState();
    const projectTargets = folders.filter((candidate) =>
      !!candidate.projectPageId && !candidate.archived && candidate.id !== folder.folderId);
    const inToday = plannerState.dailyByDate[today]?.folders
      .some((candidate) => candidate.page.id === folder.page.id) === true;
    showAppContextMenu(buildFolderContextMenuActions({
      state: {
        starred: folder.page.metadata.starred === true,
        completed: folder.status === 'completed',
        inToday,
        system: folder.folderId === 'claude' || folder.folderId === 'llm',
      },
      capability: {
        moveToProject: projectTargets.length && folder.folderSummary
          ? { enabled: true }
          : {
              enabled: false,
              reason: projectTargets.length
                ? '카드의 현재 프로젝트 정보를 확인할 수 없습니다.'
                : '이동할 다른 프로젝트가 없습니다.',
            },
        complete: folder.folderSummary
          ? { enabled: true }
          : { enabled: false, reason: '카드 정보를 확인할 수 없습니다.' },
      },
      actions: {
        open: onOpen,
        copyId: async () => { await Clipboard.setStringAsync(folder.page.id); },
        toggleStar: () => report(actions.setFolderStarred(
          folder,
          folder.page.metadata.starred !== true,
        )),
        moveToProject: () => showPicker(
          '이동할 프로젝트',
          projectTargets.map((target) => ({
            key: target.id,
            label: target.name,
            onSelect: () => report(actions.moveFolderParent(folder, {
              folderId: target.id,
              projectPageId: target.projectPageId!,
            })),
          })),
        ),
        complete: () => confirm(
          '카드 완료 처리',
          '카드를 물리 삭제하지 않고 완료 상태로 전환합니다.',
          () => report(actions.completeFolder(folder)),
        ),
        toggleToday: () => report(actions.setFolderToday(folder, today, !inToday)),
      },
    }), folder.page.title);
  }, [actions, folders, today]);

  const openProjectMenu = useCallback((input: {
    folder: Folder;
    projectPageId: string;
    onOpen(): void;
    onCreateFolder(): void;
  }) => {
    showAppContextMenu(buildProjectContextMenuActions({
      completed: input.folder.status === 'completed',
      actions: {
        open: input.onOpen,
        copyId: async () => { await Clipboard.setStringAsync(input.folder.id); },
        createFolder: input.onCreateFolder,
        setStatus: () => report((async () => {
          if (!api) throw new Error('서버 연결을 먼저 설정해 주세요.');
          const updated = await api.setFolderStatus(
            input.folder.id,
            input.folder.status === 'completed' ? 'open' : 'completed',
            requireFolderVersion(input.folder),
            Crypto.randomUUID(),
          );
          const state = useSessionStore.getState();
          state.setCatalog({
            ...state.catalog,
            folders: state.catalog.folders.map((folder) => folder.id === updated.folder.id ? updated.folder : folder),
          });
          usePlannerStore.getState().invalidate('folder');
        })()),
      },
    }), input.folder.name);
  }, [api]);

  const openChildFolderManagement = useCallback((folder: Folder) => {
    const managedFolder = folders.find((candidate) => candidate.id === folder.id) ?? folder;
    const targets = buildFolderMoveTargets(
      folders.filter((candidate) => !candidate.archived && candidate.id !== 'claude' && candidate.id !== 'llm'),
      managedFolder.id,
    );
    const updateCatalogFolder = (updated: Folder) => {
      const state = useSessionStore.getState();
      state.setCatalog({
        ...state.catalog,
        folders: state.catalog.folders.map((candidate) => candidate.id === updated.id ? updated : candidate),
      });
      usePlannerStore.getState().invalidate('folder');
    };
    showProjectManagement(managedFolder, actions, {
      nameLabel: '폴더',
      extraActions: [{
        key: 'move', label: '이동',
        onSelect: () => showPicker('이동할 상위 폴더', targets.map((target) => ({
          key: target.folderId ?? 'root',
          label: target.label,
          disabled: target.disabled,
          onSelect: () => report((async () => {
            if (!api) throw new Error('서버 연결을 먼저 설정해 주세요.');
            const result = await api.updateFolder(managedFolder.id, {
              parentFolderId: target.folderId,
              expectedVersion: requireFolderVersion(managedFolder),
              idempotencyKey: Crypto.randomUUID(),
            });
            updateCatalogFolder(result.folder);
          })()),
        }))),
      }],
    });
  }, [actions, api, folders]);

  const openSessionMenu = useCallback((input: {
    sessionId: string;
    currentFolder?: PlannerFolder;
  }) => {
    if (resumeAfterLimitInFlight.current.has(input.sessionId)) return;
    resumeAfterLimitInFlight.current.add(input.sessionId);

    const showSessionMenu = (resumeAfterLimit: MenuCapability) => {
      const folders = allFolders(usePlannerStore.getState());
      const session = useSessionStore.getState().sessions[input.sessionId];
      const associatedFolder = input.currentFolder
        ?? folders.find((folder) => folder.sessionIds.includes(input.sessionId));
      const targetFolders = folders.filter((folder) => folder.page.id !== associatedFolder?.page.id);
      showAppContextMenu(buildSessionContextMenuActions({
        capability: {
          continueSession: associatedFolder
            ? { enabled: true }
            : { enabled: false, reason: '연결된 폴더를 먼저 열어야 합니다.' },
          moveToFolder: targetFolders.length
            ? { enabled: true }
            : { enabled: false, reason: '이동할 다른 폴더가 없습니다.' },
          resumeAfterLimit,
        },
        actions: {
          copyId: async () => { await Clipboard.setStringAsync(input.sessionId); },
          continueSession: () => {
            if (associatedFolder) setSessionSuccession({
              folder: associatedFolder,
              predecessorSessionId: input.sessionId,
            });
          },
          resumeAfterLimit: async () => {
            if (!api || resumeAfterLimitInFlight.current.has(input.sessionId)) return;
            resumeAfterLimitInFlight.current.add(input.sessionId);
            try {
              const response = await api.scheduleResumeAfterLimit(input.sessionId);
              Alert.alert('재개 예약', `${formatLocalDateTime(response.run_at)} 재개 예약`);
            } catch (error) {
              Alert.alert('작업을 완료하지 못했습니다.', errorText(error));
            } finally {
              resumeAfterLimitInFlight.current.delete(input.sessionId);
            }
          },
          rename: () => promptForName(session?.displayName ?? '', (name) =>
            report(actions.renameFolderSession(input.sessionId, name))),
          moveToFolder: () => showPicker(
            '이동할 폴더',
            targetFolders.map((folder) => ({
              key: folder.page.id,
              label: folder.page.title,
              onSelect: () => report(actions.moveFolderSession(input.sessionId, folder)),
            })),
          ),
          delete: () => confirm(
            '세션 삭제',
            '이 세션을 삭제합니다.',
            () => report(actions.deleteFolderSession(input.sessionId)),
          ),
        },
      }), session?.displayName ?? input.sessionId);
    };

    void (async () => {
      try {
        if (!api) throw new Error(RESUME_AFTER_LIMIT_UNAVAILABLE_REASON);
        const response = await api.getResumeAfterLimit(input.sessionId);
        showSessionMenu(resumeAfterLimitCapability(response));
      } catch (error) {
        Alert.alert('작업을 완료하지 못했습니다.', errorText(error), [{
          text: '확인',
          onPress: () => showSessionMenu({
            enabled: false,
            reason: RESUME_AFTER_LIMIT_UNAVAILABLE_REASON,
          }),
        }]);
      } finally {
        resumeAfterLimitInFlight.current.delete(input.sessionId);
      }
    })();
  }, [actions, api]);

  const closeSessionSuccession = useCallback(() => setSessionSuccession(null), []);
  return {
    openFolderMenu,
    openProjectMenu,
    openChildFolderManagement,
    openSessionMenu,
    sessionSuccession,
    closeSessionSuccession,
  };
}

function allFolders(state: ReturnType<typeof usePlannerStore.getState>): PlannerFolder[] {
  const byId = new Map<string, PlannerFolder>();
  for (const daily of Object.values(state.dailyByDate)) {
    for (const folder of daily?.folders ?? []) byId.set(folder.page.id, folder);
  }
  for (const page of Object.values(state.folderChildPages)) {
    for (const folder of page?.items ?? []) byId.set(folder.page.id, folder);
  }
  if (state.selectedFolderSnapshot) {
    byId.set(state.selectedFolderSnapshot.page.id, state.selectedFolderSnapshot);
  }
  return [...byId.values()];
}

function showPicker(title: string, options: PlannerContextMenuAction[]) {
  showAppContextMenu(options, title);
}

function report(promise: Promise<unknown> | false | undefined) {
  if (!promise) return;
  void promise.catch((error) => Alert.alert('작업을 완료하지 못했습니다.', errorText(error)));
}

function confirm(title: string, message: string, onConfirm: () => void) {
  confirmPlannerAction({ title, message, destructive: true, onConfirm });
}

function promptForName(current: string, onSubmit: (value: string | null) => void) {
  promptPlannerText({
    title: '세션 이름 변경',
    current,
    allowBlank: true,
    onSubmit,
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireFolderVersion(folder: Folder): number {
  if (typeof folder.version !== 'number') throw new Error('폴더 버전을 확인할 수 없습니다.');
  return folder.version;
}

function resumeAfterLimitCapability(response: ResumeAfterLimitResponse): MenuCapability {
  const scheduled = response.schedule
    && EXISTING_RESUME_SCHEDULE_STATUSES.includes(response.schedule.status)
    ? response.schedule
    : null;
  const reasons = [
    response.eligible ? null : response.reason,
    scheduled
      ? `이미 ${formatLocalDateTime(scheduled.run_at)} 재개 예약되어 있습니다.`
      : null,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    enabled: response.eligible && scheduled === null,
    ...(reasons.length > 0 ? { reason: reasons.join(' · ') } : {}),
  };
}

function formatLocalDateTime(value: string): string {
  const date = new Date(value);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${hours}:${minutes}`;
}
