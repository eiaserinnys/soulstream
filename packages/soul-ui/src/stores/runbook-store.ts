import { create } from "zustand";

import type { RunbookUpdatedStreamEvent } from "../shared/stream-events";

export type RunbookAssigneeKind = "agent" | "human" | "session";
export type RunbookItemStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface RunbookAssigneeFields {
  assignee_kind: RunbookAssigneeKind | null;
  assignee_agent_id: string | null;
  assignee_session_id: string | null;
  assignee_user_id: string | null;
}

export interface RunbookRow {
  id: string;
  board_item_id: string;
  folder_id?: string | null;
  title: string;
  archived: boolean;
  version: number;
  created_session_id: string | null;
  created_event_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface RunbookSectionRow extends RunbookAssigneeFields {
  id: string;
  runbook_id: string;
  position_key: string;
  title: string;
  archived: boolean;
  version: number;
  created_session_id: string | null;
  created_event_id: number | null;
  updated_session_id: string | null;
  updated_event_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface RunbookItemRow extends RunbookAssigneeFields {
  id: string;
  section_id: string;
  position_key: string;
  title: string;
  how_to: string;
  status: RunbookItemStatus;
  archived: boolean;
  version: number;
  created_session_id: string | null;
  created_event_id: number | null;
  updated_session_id: string | null;
  updated_event_id: number | null;
  completed_kind: "agent" | "user" | null;
  completed_session_id: string | null;
  completed_event_id: number | null;
  completed_user_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunbookSnapshot {
  runbook: RunbookRow;
  sections: RunbookSectionRow[];
  items: RunbookItemRow[];
}

export interface RunbookProjection {
  snapshot: RunbookSnapshot | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  isRefreshing: boolean;
}

interface LoadOptions {
  force?: boolean;
  signal?: AbortSignal;
}

interface RunbookStoreState {
  byId: Record<string, RunbookProjection>;
  loadRunbook: (
    runbookId: string,
    options?: LoadOptions,
  ) => Promise<RunbookSnapshot | null>;
  handleRunbookUpdated: (
    event: RunbookUpdatedStreamEvent,
  ) => Promise<RunbookSnapshot | null> | undefined;
  reset: () => void;
}

const inflight = new Map<string, Promise<RunbookSnapshot | null>>();

const emptyProjection: RunbookProjection = {
  snapshot: null,
  status: "idle",
  error: null,
  isRefreshing: false,
};

function projectionFor(
  state: RunbookStoreState,
  runbookId: string,
): RunbookProjection {
  return state.byId[runbookId] ?? emptyProjection;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError";
}

async function fetchRunbookSnapshot(
  runbookId: string,
  signal?: AbortSignal,
): Promise<RunbookSnapshot | null> {
  const response = await fetch(`/api/runbooks/${encodeURIComponent(runbookId)}`, {
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Runbook fetch failed: ${response.status}`);
  }
  return await response.json() as RunbookSnapshot;
}

export const useRunbookStore = create<RunbookStoreState>((set, get) => ({
  byId: {},

  async loadRunbook(runbookId, options = {}) {
    const current = projectionFor(get(), runbookId);
    if (!options.force && current.status === "ready") {
      return current.snapshot;
    }

    const existing = inflight.get(runbookId);
    if (existing && !options.force) return existing;

    set((state) => {
      const previous = projectionFor(state, runbookId);
      return {
        byId: {
          ...state.byId,
          [runbookId]: {
            ...previous,
            status: previous.snapshot ? "ready" : "loading",
            error: null,
            isRefreshing: Boolean(previous.snapshot),
          },
        },
      };
    });

    const promise = fetchRunbookSnapshot(runbookId, options.signal)
      .then((snapshot) => {
        set((state) => ({
          byId: {
            ...state.byId,
            [runbookId]: {
              snapshot,
              status: "ready",
              error: null,
              isRefreshing: false,
            },
          },
        }));
        return snapshot;
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return projectionFor(get(), runbookId).snapshot;
        const message = error instanceof Error ? error.message : String(error);
        set((state) => {
          const previous = projectionFor(state, runbookId);
          return {
            byId: {
              ...state.byId,
              [runbookId]: {
                ...previous,
                status: "error",
                error: message,
                isRefreshing: false,
              },
            },
          };
        });
        throw error;
      })
      .finally(() => {
        if (inflight.get(runbookId) === promise) inflight.delete(runbookId);
      });

    inflight.set(runbookId, promise);
    return promise;
  },

  handleRunbookUpdated(event) {
    if (!get().byId[event.runbookId]) return undefined;
    return get().loadRunbook(event.runbookId, { force: true });
  },

  reset() {
    inflight.clear();
    set({ byId: {} });
  },
}));
