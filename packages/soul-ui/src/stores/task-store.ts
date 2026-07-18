import { create } from "zustand";

import type { TaskUpdatedStreamEvent } from "../shared/stream-events";
import {
  fetchTaskOverview,
  fetchTaskSnapshot,
  postTaskChecklistMutation,
  postTaskItemStatus,
  postTaskStatus,
} from "./task-api";
import {
  applyTaskMutationOptimistically,
  type TaskChecklistMutation,
} from "./task-mutations";

export type TaskAssigneeKind = "agent" | "human" | "session";
export type TaskItemStatus =
  | "pending"
  | "in_progress"
  | "review"
  | "completed"
  | "cancelled";
export type TaskStatus = "open" | "completed";

export interface TaskAssigneeFields {
  assignee_kind: TaskAssigneeKind | null;
  assignee_agent_id: string | null;
  assignee_session_id: string | null;
  assignee_user_id: string | null;
}

export interface TaskRow {
  id: string;
  board_item_id: string;
  folder_id?: string | null;
  title: string;
  status?: TaskStatus | null;
  archived: boolean;
  version: number;
  created_session_id: string | null;
  created_event_id: number | null;
  completed_kind?: "agent" | "user" | null;
  completed_session_id?: string | null;
  completed_event_id?: number | null;
  completed_user_id?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskSectionRow extends TaskAssigneeFields {
  id: string;
  task_id: string;
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

export interface TaskItemRow extends TaskAssigneeFields {
  id: string;
  section_id: string;
  position_key: string;
  title: string;
  how_to: string;
  status: TaskItemStatus;
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

export interface TaskSnapshot {
  task: TaskRow;
  sections: TaskSectionRow[];
  items: TaskItemRow[];
}

export interface TaskOverviewItem {
  task_id: string;
  task_title: string;
  board_item_id: string;
  folder_id: string | null;
  section_id: string;
  section_title: string;
  item_id: string;
  item_title: string;
  how_to: string;
  status: TaskItemStatus;
  item_version: number;
  task_created_session_id: string | null;
  section_created_session_id: string | null;
  section_updated_session_id: string | null;
  item_created_session_id: string | null;
  item_updated_session_id: string | null;
  effective_assignee_kind: TaskAssigneeKind | null;
  effective_assignee_agent_id: string | null;
  effective_assignee_session_id: string | null;
  effective_assignee_user_id: string | null;
}

export interface TaskOverviewGroup {
  task_id: string;
  task_title: string;
  board_item_id: string;
  folder_id: string | null;
  task_status: TaskStatus | null;
  task_version?: number | null;
  completed_kind?: "agent" | "user" | null;
  completed_session_id?: string | null;
  completed_event_id?: number | null;
  completed_user_id?: string | null;
  completed_at?: string | null;
  completed_count: number;
  total_count: number;
  updated_at: string;
  items: TaskOverviewItem[];
}

export interface TaskOverviewPayload {
  my_turn_items: TaskOverviewItem[];
  tasks: TaskOverviewGroup[];
}

export interface TaskProjection {
  snapshot: TaskSnapshot | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  isRefreshing: boolean;
}

export interface TaskOverviewProjection {
  snapshot: TaskOverviewPayload | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  isRefreshing: boolean;
}

interface LoadOptions {
  force?: boolean;
  signal?: AbortSignal;
}

export interface SetTaskItemStatusInput {
  taskId: string;
  itemId: string;
  expectedVersion: number;
  idempotencyKey: string;
  status: Extract<TaskItemStatus, "pending" | "completed" | "cancelled">;
  reason?: string | null;
}

export interface SetTaskStatusInput {
  taskId: string;
  expectedVersion: number;
  idempotencyKey: string;
  status: TaskStatus;
  reason?: string | null;
}

interface TaskStoreState {
  byId: Record<string, TaskProjection>;
  overview: TaskOverviewProjection;
  loadTask: (
    taskId: string,
    options?: LoadOptions,
  ) => Promise<TaskSnapshot | null>;
  loadOverview: (options?: LoadOptions) => Promise<TaskOverviewPayload>;
  setItemStatus: (input: SetTaskItemStatusInput) => Promise<TaskSnapshot | null>;
  setTaskStatus: (input: SetTaskStatusInput) => Promise<TaskSnapshot | null>;
  mutateChecklist: (input: TaskChecklistMutation) => Promise<TaskSnapshot>;
  handleTaskUpdated: (
    event: TaskUpdatedStreamEvent,
  ) => Promise<unknown> | undefined;
  reset: () => void;
}

const inflight = new Map<string, Promise<TaskSnapshot | null>>();
let overviewInflight: Promise<TaskOverviewPayload> | null = null;

const emptyProjection: TaskProjection = {
  snapshot: null,
  status: "idle",
  error: null,
  isRefreshing: false,
};

const emptyOverviewProjection: TaskOverviewProjection = {
  snapshot: null,
  status: "idle",
  error: null,
  isRefreshing: false,
};

function projectionFor(
  state: TaskStoreState,
  taskId: string,
): TaskProjection {
  return state.byId[taskId] ?? emptyProjection;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError";
}

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  byId: {},
  overview: emptyOverviewProjection,

  async loadTask(taskId, options = {}) {
    const current = projectionFor(get(), taskId);
    if (!options.force && current.status === "ready" && current.snapshot) {
      return current.snapshot;
    }

    const existing = inflight.get(taskId);
    if (existing && !options.force) return existing;

    set((state) => {
      const previous = projectionFor(state, taskId);
      return {
        byId: {
          ...state.byId,
          [taskId]: {
            ...previous,
            status: previous.snapshot ? "ready" : "loading",
            error: null,
            isRefreshing: Boolean(previous.snapshot),
          },
        },
      };
    });

    const promise = fetchTaskSnapshot(taskId, options.signal)
      .then((snapshot) => {
        set((state) => ({
          byId: {
            ...state.byId,
            [taskId]: {
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
        if (isAbortError(error)) return projectionFor(get(), taskId).snapshot;
        const message = error instanceof Error ? error.message : String(error);
        set((state) => {
          const previous = projectionFor(state, taskId);
          return {
            byId: {
              ...state.byId,
              [taskId]: {
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
        if (inflight.get(taskId) === promise) inflight.delete(taskId);
      });

    inflight.set(taskId, promise);
    return promise;
  },

  async loadOverview(options = {}) {
    const current = get().overview;
    if (!options.force && current.status === "ready" && current.snapshot) {
      return current.snapshot;
    }

    if (overviewInflight && !options.force) return overviewInflight;

    set((state) => ({
      overview: {
        ...state.overview,
        status: state.overview.snapshot ? "ready" : "loading",
        error: null,
        isRefreshing: Boolean(state.overview.snapshot),
      },
    }));

    const promise = fetchTaskOverview(options.signal)
      .then((snapshot) => {
        set({
          overview: {
            snapshot,
            status: "ready",
            error: null,
            isRefreshing: false,
          },
        });
        return snapshot;
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          const previous = get().overview.snapshot;
          if (previous) return previous;
        }
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({
          overview: {
            ...state.overview,
            status: "error",
            error: message,
            isRefreshing: false,
          },
        }));
        throw error;
      })
      .finally(() => {
        if (overviewInflight === promise) overviewInflight = null;
      });

    overviewInflight = promise;
    return promise;
  },

  async setItemStatus(input) {
    const result = await postTaskItemStatus(input);
    const snapshot = result.snapshot ?? null;
    if (snapshot) {
      set((state) => ({
        byId: {
          ...state.byId,
          [input.taskId]: {
            snapshot,
            status: "ready",
            error: null,
            isRefreshing: false,
          },
        },
      }));
    }
    return snapshot;
  },

  async setTaskStatus(input) {
    const result = await postTaskStatus(input);
    const snapshot = result.snapshot ?? null;
    if (snapshot) {
      set((state) => ({
        byId: {
          ...state.byId,
          [input.taskId]: {
            snapshot,
            status: "ready",
            error: null,
            isRefreshing: false,
          },
        },
      }));
    }
    return snapshot;
  },

  async mutateChecklist(input) {
    const previousProjection = projectionFor(get(), input.taskId);
    const previousSnapshot = previousProjection.snapshot;
    if (!previousSnapshot) throw new Error("Task must be loaded before editing");

    const optimisticSnapshot = applyTaskMutationOptimistically(previousSnapshot, input);
    set((state) => ({
      byId: {
        ...state.byId,
        [input.taskId]: {
          snapshot: optimisticSnapshot,
          status: "ready",
          error: null,
          isRefreshing: false,
        },
      },
    }));

    try {
      const result = await postTaskChecklistMutation(input);
      const snapshot = result.snapshot ?? optimisticSnapshot;
      set((state) => ({
        byId: {
          ...state.byId,
          [input.taskId]: {
            snapshot,
            status: "ready",
            error: null,
            isRefreshing: false,
          },
        },
      }));
      return snapshot;
    } catch (error) {
      set((state) => ({
        byId: {
          ...state.byId,
          [input.taskId]: previousProjection,
        },
      }));
      throw error;
    }
  },

  handleTaskUpdated(event) {
    const tasks: Promise<unknown>[] = [];
    if (get().byId[event.taskId]) {
      tasks.push(get().loadTask(event.taskId, { force: true }));
    }
    if (get().overview.status !== "idle" || get().overview.snapshot) {
      tasks.push(get().loadOverview({ force: true }));
    }
    if (tasks.length === 0) return undefined;
    return Promise.allSettled(tasks);
  },

  reset() {
    inflight.clear();
    overviewInflight = null;
    set({ byId: {}, overview: emptyOverviewProjection });
  },
}));
