import { createApiClient, type ApiClient } from '../api/client';
import type {
  PlannerSessionSummary,
  PlannerFolder,
} from '../api/plannerTypes';
import { plannerFolderDetailToSummary } from '../api/plannerTypes';
import type { Session } from '../api/types';
import {
  bindPlannerFolderScope,
  isPlannerFolderInCurrentScope,
  usePlannerStore,
} from '../store/plannerStore';
import { useSessionStore } from '../store/sessionStore';
import { useUIStore } from '../store/uiStore';
import {
  SessionFolderResolutionCancelledError,
  SessionFolderResolutionError,
  createSessionFolderResolver,
  createSessionFolderWorkspaceController,
  type SessionFolderResolverScope,
} from './session-folder-resolver';
import {
  coordinateFolderWorkspaceClose,
} from './planner-folder-title-save';
import {
  captureAuthScope,
  isAuthScopeCurrent,
  subscribeAuthScope,
  type AuthScopeSnapshot,
} from './auth-scope';
import {
  createUiUsageFlowId,
  recordUiUsageEvent,
  type UiEventEntry,
  type UiEventTarget,
} from './ui-usage-events';

interface PlannerResolutionScope extends SessionFolderResolverScope {
  auth: AuthScopeSnapshot;
  serverUrl: string;
  client: ApiClient;
}

export function openPlannerFolderWorkspace(
  folder: PlannerFolder,
  entry: UiEventEntry = 'nav',
): void {
  if (!isPlannerFolderInCurrentScope(folder)) return;
  recordPlannerView({ kind: 'folder', id: folder.folderId }, entry);
  bindPlannerFolderScope(folder);
  coordinateFolderWorkspaceClose(useUIStore.getState().selectedFolderPageId);
  sessionFolderResolver.prime(folder);
  usePlannerStore.getState().setSelectedFolderSnapshot(folder);
  useUIStore.getState().openFolderOverlay(
    folder.page.id,
    folder.sessionIds[0] ?? null,
  );
}

export function openStarredPageWorkspace(
  pageId: string,
  entry: UiEventEntry = 'nav',
): void {
  recordPlannerView({ kind: 'page', id: pageId }, entry);
  coordinateFolderWorkspaceClose(useUIStore.getState().selectedFolderPageId);
  usePlannerStore.getState().setSelectedFolderSnapshot(null);
  useUIStore.getState().openFolderOverlay(pageId, null);
}

const sessionFolderResolver = createSessionFolderResolver({
  captureScope: captureResolutionScope,
  isScopeCurrent: isResolutionScopeCurrent,
  getSession: getSessionForResolution,
  hydrateFolder: hydrateLinkedFolder,
});

const sessionFolderWorkspaceController = createSessionFolderWorkspaceController(
  sessionFolderResolver,
  {
    showLoading: (sessionId, focusEventId, storyOpenRequestId) => {
      usePlannerStore.getState().setSelectedFolderSnapshot(null);
      useUIStore.getState().openResolvingSessionOverlay(
        sessionId,
        focusEventId,
        storyOpenRequestId,
      );
    },
    showLinked: (folder, sessionId, focusEventId, storyOpenRequestId) => {
      bindPlannerFolderScope(folder);
      usePlannerStore.getState().setSelectedFolderSnapshot(folder);
      useUIStore.getState().openFolderOverlay(
        folder.page.id,
        sessionId,
        focusEventId,
        storyOpenRequestId,
      );
    },
    showUnlinked: (sessionId, focusEventId, storyOpenRequestId) => {
      usePlannerStore.getState().setSelectedFolderSnapshot(null);
      useUIStore.getState().openSessionOverlay(
        sessionId,
        focusEventId,
        storyOpenRequestId,
      );
    },
    showError: (sessionId, focusEventId, message, retryable, storyOpenRequestId) => {
      usePlannerStore.getState().setSelectedFolderSnapshot(null);
      useUIStore.getState().openSessionResolutionError(
        sessionId,
        focusEventId,
        message,
        retryable,
        storyOpenRequestId,
      );
    },
    cancelLoading: (sessionId) => {
      useUIStore.getState().cancelSessionResolution(sessionId);
    },
  },
);

subscribeAuthScope((current, previous) => {
  if (!previous || current.generation === previous.generation) return;
  // registry/cache/queue는 generation 수명과 함께 끝난다. JWT 원문은 어느 key에도 남지 않는다.
  sessionFolderResolver.reset();
});

/** 알림과 피드가 공유하는 iPad session→folder 단일 진입점. */
export function openPlannerSessionWorkspace(
  sessionId: string,
  focusEventId?: number | null,
  storyOpenRequestId?: number | null,
  entry: UiEventEntry = 'nav',
  sessionSearchIntentId?: number,
): Promise<boolean> {
  useUIStore.getState().setSessionSearchIntentId(sessionSearchIntentId ?? null);
  recordPlannerView({ kind: 'session', id: sessionId }, entry);
  coordinateFolderWorkspaceClose(useUIStore.getState().selectedFolderPageId);
  return recordSessionResolution(sessionId, focusEventId, storyOpenRequestId, entry);
}

/** Resolve a session's accessible linked folder for phone navigation. */
export async function resolvePlannerSessionFolder(
  sessionId: string,
): Promise<PlannerFolder | null> {
  sessionFolderResolver.cancelStale(sessionId);
  const resolution = await sessionFolderResolver.resolve(sessionId);
  return resolution.kind === 'linked' ? resolution.folder : null;
}

export function retryPlannerSessionWorkspace(
  sessionId: string,
  focusEventId?: number | null,
  storyOpenRequestId?: number | null,
): void {
  recordSessionResolution(sessionId, focusEventId, storyOpenRequestId, 'nav');
}

/** Cancel a session workspace open started from a root deep link. */
export function cancelPlannerSessionWorkspaceOpen(): void {
  sessionFolderWorkspaceController.cancel();
}

function recordSessionResolution(
  sessionId: string,
  focusEventId: number | null | undefined,
  storyOpenRequestId: number | null | undefined,
  entry: UiEventEntry,
): Promise<boolean> {
  const sessionSearchIntentId = useUIStore.getState().sessionSearchIntentId;
  const flowId = createUiUsageFlowId();
  const startedAt = Date.now();
  if (flowId) {
    recordUiUsageEvent({
      type: 'action_start',
      target: { kind: 'session', id: sessionId },
      entry,
      flowId,
      attrs: { action: 'session_resolution' },
    });
  }
  return sessionFolderWorkspaceController.open(
    sessionId,
    focusEventId,
    storyOpenRequestId,
  ).then(() => {
    const state = useUIStore.getState();
    const resolution = state.sessionFolderResolution;
    const opened = state.activeSessionId === sessionId
      && (state.selectedFolderPageId !== null
        || (resolution?.sessionId === sessionId
          && resolution.status === 'unlinked'));
    if (opened && sessionSearchIntentId !== null) {
      useUIStore.getState().completeSessionSearchIntent(sessionSearchIntentId);
    }
    if (!flowId || state.activeSessionId !== sessionId) return opened;
    recordUiUsageEvent({
      type: 'action_end',
      target: { kind: 'session', id: sessionId },
      entry,
      flowId,
      attrs: resolution?.status === 'error'
        ? {
          action: 'session_resolution',
          status: 'error',
          durationMs: Date.now() - startedAt,
          errorCode: 'session_resolution',
        }
        : {
          action: 'session_resolution',
          status: 'ok',
          durationMs: Date.now() - startedAt,
        },
    });
    return opened;
  });
}

function recordPlannerView(target: UiEventTarget, entry: UiEventEntry): void {
  recordUiUsageEvent({
    type: 'view_open',
    target,
    from: currentPlannerUsageTarget(),
    entry,
  });
}

/** 수집 시작 시점의 tablet workspace 대상만 한 번 스냅샷한다. */
export function recordCurrentPlannerUsageView(): boolean {
  const target = currentPlannerUsageTarget();
  return target ? recordUiUsageEvent({
    type: 'view_open',
    target,
    from: null,
    entry: 'auto',
  }) : false;
}

export function currentPlannerUsageTarget(): UiEventTarget | null {
  const state = useUIStore.getState();
  if (state.activeSessionId) return { kind: 'session', id: state.activeSessionId };
  if (state.selectedFolderPageId) return { kind: 'page', id: state.selectedFolderPageId };
  if (state.activeSection.kind === 'project') {
    return { kind: 'page', id: state.activeSection.projectPageId };
  }
  return { kind: 'view', id: `daily:${state.activeSection.date}` };
}

function captureResolutionScope(): PlannerResolutionScope {
  const auth = captureAuthScope();
  const { serverUrl, generation } = auth;
  if (!serverUrl) {
    throw new SessionFolderResolutionError('서버 연결 설정이 없습니다.');
  }
  return {
    generation,
    auth,
    serverUrl,
    client: createApiClient(serverUrl, { authScope: auth }),
  };
}

function isResolutionScopeCurrent(scope: PlannerResolutionScope): boolean {
  return isAuthScopeCurrent(scope.auth);
}

async function getSessionForResolution(
  sessionId: string,
  scope: PlannerResolutionScope,
): Promise<Session | null> {
  // 업무 cache miss를 판정하는 동안에는 feed/catalog의 부분 projection도 정본으로 믿지 않는다.
  // 특히 오래된 folderId=null을 재사용하면 실제 업무 세션을 거짓 미소속으로 강등한다.
  const sessions = await scope.client.getSessionsByIds([sessionId]);
  const selected = sessions.find((session) => session.agentSessionId === sessionId) ?? null;
  if (isResolutionScopeCurrent(scope)) useSessionStore.getState().mergeSessions(sessions);
  return selected;
}

async function hydrateLinkedFolder(
  folderId: string,
  selectedSession: Session,
  scope: PlannerResolutionScope,
): Promise<PlannerFolder> {
  const detail = await scope.client.getPlannerFolder(folderId,{includeCompleted:false});
  assertResolutionScope(scope);
  if (detail.folder.archived) {
    throw new SessionFolderResolutionError('연결된 폴더는 보관되어 열 수 없습니다.', {
      retryable: false,
    });
  }
  const folder = plannerFolderDetailToSummary(detail);
  if (!folder.sessionIds.includes(selectedSession.agentSessionId)) {
    folder.sessions.push(toPlannerSessionSummary(selectedSession));
    folder.sessionIds.push(selectedSession.agentSessionId);
  }
  return folder;
}

function assertResolutionScope(scope: PlannerResolutionScope): void {
  if (!isResolutionScopeCurrent(scope)) throw new SessionFolderResolutionCancelledError();
}

function toPlannerSessionSummary(session: Session): PlannerSessionSummary {
  return {
    agentSessionId: session.agentSessionId,
    folderId: session.folderId ?? null,
    displayName: session.displayName,
    nodeId: session.nodeId ?? null,
    sessionType: session.sessionType ?? null,
    status: session.status,
    agentId: session.agentId ?? null,
    modelPreset: session.modelPreset ?? null,
    callerSessionId: session.callerSessionId ?? null,
    predecessorSessionId: null,
    reviewState: session.reviewState ?? 'not_required',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function resetPlannerSessionResolverForTest(): void {
  sessionFolderResolver.reset();
}
