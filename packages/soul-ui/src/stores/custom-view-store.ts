import { create } from "zustand";

import type { CustomViewDocument } from "../shared/types";
import type { CustomViewUpdatedStreamEvent } from "../shared/stream-events";

interface LoadOptions {
  force?: boolean;
  signal?: AbortSignal;
}

interface CustomViewProjection {
  document: CustomViewDocument | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  isRefreshing: boolean;
}

interface CustomViewStoreState {
  byId: Record<string, CustomViewProjection>;
  loadCustomView: (
    customViewId: string,
    options?: LoadOptions,
  ) => Promise<CustomViewDocument | null>;
  handleCustomViewUpdated: (
    event: CustomViewUpdatedStreamEvent,
  ) => Promise<unknown> | undefined;
  reset: () => void;
}

const inflight = new Map<string, Promise<CustomViewDocument | null>>();

const emptyProjection: CustomViewProjection = {
  document: null,
  status: "idle",
  error: null,
  isRefreshing: false,
};

function projectionFor(
  state: CustomViewStoreState,
  customViewId: string,
): CustomViewProjection {
  return state.byId[customViewId] ?? emptyProjection;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError";
}

async function fetchCustomView(
  customViewId: string,
  signal?: AbortSignal,
): Promise<CustomViewDocument> {
  const res = await fetch(`/api/custom-views/${encodeURIComponent(customViewId)}`, { signal });
  if (!res.ok) {
    throw new Error(`Custom view fetch failed (${res.status})`);
  }
  return await res.json() as CustomViewDocument;
}

export const useCustomViewStore = create<CustomViewStoreState>((set, get) => ({
  byId: {},

  async loadCustomView(customViewId, options = {}) {
    const current = projectionFor(get(), customViewId);
    if (!options.force && current.status === "ready") {
      return current.document;
    }

    const existing = inflight.get(customViewId);
    if (existing && !options.force) return existing;

    set((state) => {
      const previous = projectionFor(state, customViewId);
      return {
        byId: {
          ...state.byId,
          [customViewId]: {
            ...previous,
            status: previous.document ? "ready" : "loading",
            error: null,
            isRefreshing: Boolean(previous.document),
          },
        },
      };
    });

    const promise = fetchCustomView(customViewId, options.signal)
      .then((document) => {
        set((state) => ({
          byId: {
            ...state.byId,
            [customViewId]: {
              document,
              status: "ready",
              error: null,
              isRefreshing: false,
            },
          },
        }));
        return document;
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return projectionFor(get(), customViewId).document;
        const message = error instanceof Error ? error.message : String(error);
        set((state) => {
          const previous = projectionFor(state, customViewId);
          return {
            byId: {
              ...state.byId,
              [customViewId]: {
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
        if (inflight.get(customViewId) === promise) inflight.delete(customViewId);
      });

    inflight.set(customViewId, promise);
    return promise;
  },

  handleCustomViewUpdated(event) {
    if (!get().byId[event.customViewId]) return undefined;
    return get().loadCustomView(event.customViewId, { force: true });
  },

  reset() {
    inflight.clear();
    set({ byId: {} });
  },
}));
