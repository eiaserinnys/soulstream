import { create } from "zustand";
import type { FolderUpdatedStreamEvent } from "../shared/stream-events";
import {
  fetchFolderSnapshot,
  postChecklistMutation,
  postChecklistItemStatus,
  postFolderStatus,
} from "./folder-checklist-api";
import { applyChecklistMutationOptimistically, type ChecklistMutation } from "./checklist-mutations";

export type ChecklistItemStatus = "pending" | "in_progress" | "review" | "completed" | "cancelled";
export type ChecklistAssigneeKind = "agent" | "human" | "session";
export type FolderStatus = "open" | "completed";
export type FolderCompletionKind = "agent" | "user" | "llm";

export interface ChecklistAssigneeFields {
  assigneeKind: ChecklistAssigneeKind | null;
  assigneeAgentId: string | null;
  assigneeSessionId: string | null;
  assigneeUserId: string | null;
}

export interface FolderRow {
  id: string;
  name: string;
  parentFolderId: string | null;
  projectPageId: string | null;
  checklistEnabled: boolean;
  status: FolderStatus;
  archived: boolean;
  version: number;
  createdSessionId: string | null;
  createdEventId: number | null;
  completedKind: FolderCompletionKind | null;
  completedSessionId: string | null;
  completedEventId: number | null;
  completedUserId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChecklistSectionRow extends ChecklistAssigneeFields {
  id: string;
  folderId: string;
  positionKey: string;
  title: string;
  archived: boolean;
  version: number;
  createdSessionId: string | null;
  createdEventId: number | null;
  updatedSessionId: string | null;
  updatedEventId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChecklistItemRow extends ChecklistAssigneeFields {
  id: string;
  sectionId: string;
  positionKey: string;
  title: string;
  howTo: string;
  status: ChecklistItemStatus;
  archived: boolean;
  version: number;
  createdSessionId: string | null;
  createdEventId: number | null;
  updatedSessionId: string | null;
  updatedEventId: number | null;
  completedKind: FolderCompletionKind | null;
  completedSessionId: string | null;
  completedEventId: number | null;
  completedUserId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FolderSnapshot {
  folder: FolderRow;
  sections: ChecklistSectionRow[];
  items: ChecklistItemRow[];
}

export interface FolderProjection {
  snapshot: FolderSnapshot | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  isRefreshing: boolean;
}

export interface SetChecklistItemStatusInput {
  folderId: string;
  itemId: string;
  expectedVersion: number;
  idempotencyKey: string;
  status: Extract<ChecklistItemStatus, "pending" | "completed" | "cancelled">;
  reason?: string | null;
}

export interface SetFolderStatusInput {
  folderId: string;
  expectedVersion: number;
  idempotencyKey: string;
  status: FolderStatus;
  reason?: string | null;
}

interface LoadOptions { force?: boolean; signal?: AbortSignal }
interface FolderChecklistStoreState {
  byId: Record<string, FolderProjection>;
  loadFolder(folderId: string, options?: LoadOptions): Promise<FolderSnapshot | null>;
  setItemStatus(input: SetChecklistItemStatusInput): Promise<FolderSnapshot | null>;
  setFolderStatus(input: SetFolderStatusInput): Promise<FolderSnapshot | null>;
  mutateChecklist(input: ChecklistMutation): Promise<FolderSnapshot>;
  handleFolderUpdated(event: FolderUpdatedStreamEvent): Promise<unknown> | undefined;
  reset(): void;
}

const inflight = new Map<string, Promise<FolderSnapshot | null>>();
const emptyProjection: FolderProjection = { snapshot: null, status: "idle", error: null, isRefreshing: false };
const projectionFor = (state: FolderChecklistStoreState, folderId: string) => state.byId[folderId] ?? emptyProjection;

export const useFolderChecklistStore = create<FolderChecklistStoreState>((set, get) => ({
  byId: {},
  async loadFolder(folderId, options = {}) {
    const previous = projectionFor(get(), folderId);
    if (!options.force && previous.status === "ready" && previous.snapshot) return previous.snapshot;
    const existing = inflight.get(folderId);
    if (existing && !options.force) return existing;
    set((state) => ({ byId: { ...state.byId, [folderId]: {
      ...projectionFor(state, folderId),
      status: previous.snapshot ? "ready" : "loading",
      error: null,
      isRefreshing: Boolean(previous.snapshot),
    } } }));
    const promise = fetchFolderSnapshot(folderId, options.signal)
      .then((snapshot) => {
        set((state) => ({ byId: { ...state.byId, [folderId]: {
          snapshot, status: "ready", error: null, isRefreshing: false,
        } } }));
        return snapshot;
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return projectionFor(get(), folderId).snapshot;
        set((state) => ({ byId: { ...state.byId, [folderId]: {
          ...projectionFor(state, folderId), status: "error",
          error: error instanceof Error ? error.message : String(error), isRefreshing: false,
        } } }));
        throw error;
      })
      .finally(() => { if (inflight.get(folderId) === promise) inflight.delete(folderId); });
    inflight.set(folderId, promise);
    return promise;
  },
  async setItemStatus(input) {
    await postChecklistItemStatus(input);
    return get().loadFolder(input.folderId, { force: true });
  },
  async setFolderStatus(input) {
    await postFolderStatus(input);
    return get().loadFolder(input.folderId, { force: true });
  },
  async mutateChecklist(input) {
    const previous = projectionFor(get(), input.folderId);
    if (!previous.snapshot) throw new Error("체크리스트를 먼저 불러와야 합니다");
    set((state) => ({ byId: { ...state.byId, [input.folderId]: {
      ...previous, snapshot: applyChecklistMutationOptimistically(previous.snapshot!, input),
    } } }));
    try {
      await postChecklistMutation(input);
      const snapshot = await get().loadFolder(input.folderId, { force: true });
      if (!snapshot) throw new Error("변경한 폴더를 찾을 수 없습니다");
      return snapshot;
    } catch (error) {
      set((state) => ({ byId: { ...state.byId, [input.folderId]: previous } }));
      throw error;
    }
  },
  handleFolderUpdated(event) {
    if (!get().byId[event.folderId]) return undefined;
    return get().loadFolder(event.folderId, { force: true });
  },
  reset() { inflight.clear(); set({ byId: {} }); },
}));
