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

export interface RunbookOverviewItem {
  runbook_id: string;
  runbook_title: string;
  board_item_id: string;
  folder_id: string | null;
  section_id: string;
  section_title: string;
  item_id: string;
  item_title: string;
  how_to: string;
  status: RunbookItemStatus;
  item_version: number;
  effective_assignee_kind: RunbookAssigneeKind | null;
  effective_assignee_agent_id: string | null;
  effective_assignee_session_id: string | null;
  effective_assignee_user_id: string | null;
}

export interface RunbookOverviewGroup {
  runbook_id: string;
  runbook_title: string;
  board_item_id: string;
  folder_id: string | null;
  completed_count: number;
  total_count: number;
  updated_at: string;
  items: RunbookOverviewItem[];
}

export interface RunbookOverviewPayload {
  my_turn_items: RunbookOverviewItem[];
  runbooks: RunbookOverviewGroup[];
}

export interface RunbookProjection {
  snapshot: RunbookSnapshot | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  isRefreshing: boolean;
}

export interface RunbookOverviewProjection {
  snapshot: RunbookOverviewPayload | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  isRefreshing: boolean;
}

interface LoadOptions {
  force?: boolean;
  signal?: AbortSignal;
}

export interface SetRunbookItemStatusInput {
  runbookId: string;
  itemId: string;
  expectedVersion: number;
  idempotencyKey: string;
  status: Extract<RunbookItemStatus, "pending" | "completed" | "cancelled">;
  reason?: string | null;
}

interface RunbookItemStatusResponse {
  ok: boolean;
  snapshot?: RunbookSnapshot;
}

interface RunbookStoreState {
  byId: Record<string, RunbookProjection>;
  overview: RunbookOverviewProjection;
  loadRunbook: (
    runbookId: string,
    options?: LoadOptions,
  ) => Promise<RunbookSnapshot | null>;
  loadOverview: (options?: LoadOptions) => Promise<RunbookOverviewPayload>;
  setItemStatus: (input: SetRunbookItemStatusInput) => Promise<RunbookSnapshot | null>;
  handleRunbookUpdated: (
    event: RunbookUpdatedStreamEvent,
  ) => Promise<unknown> | undefined;
  reset: () => void;
}

const inflight = new Map<string, Promise<RunbookSnapshot | null>>();
let overviewInflight: Promise<RunbookOverviewPayload> | null = null;

const emptyProjection: RunbookProjection = {
  snapshot: null,
  status: "idle",
  error: null,
  isRefreshing: false,
};

const emptyOverviewProjection: RunbookOverviewProjection = {
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractRunbookErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string") return nonEmptyString(payload);
  if (typeof payload !== "object" || payload === null) return null;

  const record = payload as Record<string, unknown>;
  const detail = record.detail;
  if (typeof detail === "object" && detail !== null) {
    const detailRecord = detail as Record<string, unknown>;
    const error = detailRecord.error;
    if (typeof error === "object" && error !== null) {
      const message = nonEmptyString((error as Record<string, unknown>).message);
      if (message) return message;
    }
    const detailMessage = nonEmptyString(detailRecord.message);
    if (detailMessage) return detailMessage;
  }
  const detailMessage = nonEmptyString(detail);
  if (detailMessage) return detailMessage;

  const error = record.error;
  if (typeof error === "object" && error !== null) {
    const message = nonEmptyString((error as Record<string, unknown>).message);
    if (message) return message;
  }
  const errorMessage = nonEmptyString(error);
  if (errorMessage) return errorMessage;

  return nonEmptyString(record.message);
}

async function readRunbookErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const payload = await response.json();
    return extractRunbookErrorMessage(payload) ?? fallback;
  } catch {
    return fallback;
  }
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
    throw new Error(await readRunbookErrorMessage(
      response,
      `Runbook fetch failed: ${response.status}`,
    ));
  }
  return await response.json() as RunbookSnapshot;
}

async function fetchRunbookOverview(
  signal?: AbortSignal,
): Promise<RunbookOverviewPayload> {
  const response = await fetch("/api/runbooks/my-turn", { signal });
  if (!response.ok) {
    throw new Error(await readRunbookErrorMessage(
      response,
      `Runbook overview fetch failed: ${response.status}`,
    ));
  }
  return await response.json() as RunbookOverviewPayload;
}

async function postRunbookItemStatus(
  input: SetRunbookItemStatusInput,
): Promise<RunbookItemStatusResponse> {
  const response = await fetch(
    `/api/runbooks/${encodeURIComponent(input.runbookId)}/items/${encodeURIComponent(input.itemId)}/status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        status: input.status,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(await readRunbookErrorMessage(
      response,
      `Runbook status update failed: ${response.status}`,
    ));
  }
  return await response.json() as RunbookItemStatusResponse;
}

export const useRunbookStore = create<RunbookStoreState>((set, get) => ({
  byId: {},
  overview: emptyOverviewProjection,

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

    const promise = fetchRunbookOverview(options.signal)
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
    const result = await postRunbookItemStatus(input);
    const snapshot = result.snapshot ?? null;
    if (snapshot) {
      set((state) => ({
        byId: {
          ...state.byId,
          [input.runbookId]: {
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

  handleRunbookUpdated(event) {
    const tasks: Promise<unknown>[] = [];
    if (get().byId[event.runbookId]) {
      tasks.push(get().loadRunbook(event.runbookId, { force: true }));
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
