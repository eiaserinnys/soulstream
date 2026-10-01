import type { PlannerFolder } from '../api/plannerTypes';
import { captureAuthScope, subscribeAuthScope } from './auth-scope';

export interface PlannerFolderTitleBinding {
  scopeGeneration: string;
  folder: PlannerFolder;
  getDraft(): string;
  getServerTitle(): string;
  save(folder: PlannerFolder, title: string): Promise<unknown>;
  onSaved?(title: string): void;
  onError?(error: unknown): void;
}

interface SaveSnapshot {
  scopeGeneration: string;
  folder: PlannerFolder;
  title: string;
  save: PlannerFolderTitleBinding['save'];
  onSaved?: PlannerFolderTitleBinding['onSaved'];
  onError?: PlannerFolderTitleBinding['onError'];
}

interface FolderQueueState {
  disposed?: boolean;
  binding?: PlannerFolderTitleBinding;
  lastSnapshot?: SaveSnapshot;
  confirmedTitle?: string;
  retainedDraft?: string;
  queued?: SaveSnapshot;
  running?: SaveSnapshot;
}

export interface PlannerFolderTitleSaveCoordinator {
  bind(binding: PlannerFolderTitleBinding): () => void;
  setDraft(folderPageId: string, title: string, scopeGeneration?: string): void;
  preferredTitle(folderPageId: string, serverTitle: string, scopeGeneration?: string): string;
  enqueueLatest(folderPageId: string, scopeGeneration?: string): void;
  close(folderPageId: string | null | undefined, close?: () => void): void;
  disposeScope(scopeGeneration: string): void;
  reset(): void;
}

export function createPlannerFolderTitleSaveCoordinator(): PlannerFolderTitleSaveCoordinator {
  const states = new Map<string, FolderQueueState>();

  const stateFor = (scopeGeneration: string, folderPageId: string): FolderQueueState => {
    const key = stateKey(scopeGeneration, folderPageId);
    const existing = states.get(key);
    if (existing) return existing;
    const state: FolderQueueState = {};
    states.set(key, state);
    return state;
  };

  const drain = async (
    scopeGeneration: string,
    folderPageId: string,
    state: FolderQueueState,
  ): Promise<void> => {
    if (state.running) return;
    while (state.queued && !state.disposed) {
      const submitted = state.queued;
      state.queued = undefined;
      if (sameTitle(submitted.title, state.confirmedTitle)) continue;
      state.running = submitted;
      try {
        await submitted.save(submitted.folder, submitted.title);
        if (state.disposed || submitted.scopeGeneration !== scopeGeneration) return;
        state.confirmedTitle = submitted.title;
        submitted.onSaved?.(submitted.title);
      } catch (error) {
        if (state.disposed || submitted.scopeGeneration !== scopeGeneration) return;
        submitted.onError?.(error);
        // 더 최신 snapshot이 이미 있으면 그것이 실패한 값을 대체한다. 그렇지 않으면
        // 실패 snapshot을 그대로 남겨 다음 blur/close/remount에서 재시도한다.
        state.queued ??= submitted;
        state.running = undefined;
        break;
      }
      state.running = undefined;
    }
  };

  const enqueueLatest = (
    folderPageId: string,
    scopeGeneration = captureAuthScope().generation,
  ): void => {
    const state = states.get(stateKey(scopeGeneration, folderPageId));
    if (!state) return;
    const binding = state.binding;
    const snapshot = binding
      ? {
          scopeGeneration,
          folder: binding.folder,
          title: binding.getDraft(),
          save: binding.save,
          onSaved: binding.onSaved,
          onError: binding.onError,
        }
      : state.lastSnapshot;
    if (!snapshot) return;
    state.lastSnapshot = snapshot;
    state.retainedDraft = snapshot.title;
    if (sameTitle(snapshot.title, state.confirmedTitle ?? binding?.getServerTitle())) return;
    state.queued = snapshot;
    void drain(scopeGeneration, folderPageId, state);
  };

  return {
    bind(binding) {
      const folderPageId = binding.folder.page.id;
      const { scopeGeneration } = binding;
      const state = stateFor(scopeGeneration, folderPageId);
      state.disposed = false;
      state.binding = binding;
      if (state.confirmedTitle === undefined || !hasPendingSave(state)) {
        state.confirmedTitle = binding.getServerTitle();
      }
      state.lastSnapshot = {
        scopeGeneration,
        folder: binding.folder,
        title: state.retainedDraft ?? binding.getDraft(),
        save: binding.save,
        onSaved: binding.onSaved,
        onError: binding.onError,
      };
      return () => {
        // 예상하지 못한 unmount도 같은 큐 진입점으로 수렴한다.
        enqueueLatest(folderPageId, scopeGeneration);
        if (state.binding === binding) state.binding = undefined;
      };
    },
    setDraft(folderPageId, title, scopeGeneration = captureAuthScope().generation) {
      stateFor(scopeGeneration, folderPageId).retainedDraft = title;
    },
    preferredTitle(folderPageId, serverTitle, scopeGeneration = captureAuthScope().generation) {
      const state = states.get(stateKey(scopeGeneration, folderPageId));
      if (!state) return serverTitle;
      if (!hasPendingSave(state)) {
        state.confirmedTitle = serverTitle;
        state.retainedDraft = serverTitle;
        return serverTitle;
      }
      if (state.retainedDraft !== undefined && !sameTitle(
        state.retainedDraft,
        state.confirmedTitle ?? serverTitle,
      )) return state.retainedDraft;
      return state.confirmedTitle ?? serverTitle;
    },
    enqueueLatest,
    close(folderPageId, close) {
      // 이벤트 핸들러 안에서 snapshot을 먼저 동기적으로 큐에 넣은 다음 UI를 닫는다.
      if (folderPageId) enqueueLatest(folderPageId);
      close?.();
    },
    disposeScope(scopeGeneration) {
      for (const [key, state] of states) {
        if (!key.startsWith(`${scopeGeneration}\u0000`)) continue;
        state.disposed = true;
        state.binding = undefined;
        state.queued = undefined;
        states.delete(key);
      }
    },
    reset() {
      states.clear();
    },
  };
}

function stateKey(scopeGeneration: string, folderPageId: string): string {
  return `${scopeGeneration}\u0000${folderPageId}`;
}

function sameTitle(left: string | undefined, right: string | undefined): boolean {
  return left?.trim() === right?.trim();
}

function hasPendingSave(state: FolderQueueState): boolean {
  return Boolean(state.queued || state.running) || (
    state.retainedDraft !== undefined
    && !sameTitle(state.retainedDraft, state.confirmedTitle)
  );
}

export const plannerFolderTitleSaveCoordinator = createPlannerFolderTitleSaveCoordinator();

subscribeAuthScope((current, previous) => {
  if (previous && current.generation !== previous.generation) {
    plannerFolderTitleSaveCoordinator.disposeScope(previous.generation);
  }
});

export function coordinateFolderWorkspaceClose(
  folderPageId: string | null | undefined,
  close?: () => void,
): void {
  plannerFolderTitleSaveCoordinator.close(folderPageId, close);
}
