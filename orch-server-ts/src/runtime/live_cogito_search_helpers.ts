import {
  DEFAULT_SEARCH_CATEGORIES,
  eventTypesForSearchCategories,
  parseSearchEventCategories,
} from "@soulstream/search-contract";

import type { CogitoSearchParams } from "../cogito/cogito_routes.js";
import { SearchDeadlineError } from "./live_session_search_candidates.js";

export function resolveProductFolderScope(
  params: CogitoSearchParams,
): readonly string[] | undefined {
  const selectedFolderId = params.session_filters?.folder_id;
  if (selectedFolderId === undefined) return params.allowedFolderIds;
  if (params.allowedFolderIds === undefined) return [selectedFolderId];
  return params.allowedFolderIds.filter((folderId) => folderId === selectedFolderId);
}

export function sourceFailureReason(
  error: unknown,
  signal: AbortSignal,
  deadlineAt: number,
  deadlineExpired: boolean,
): "timeout" | "cancelled" | "error" {
  if (deadlineExpired || Date.now() >= deadlineAt) return "timeout";
  if (signal.aborted) return "cancelled";
  if (error instanceof SearchDeadlineError) return "timeout";
  if (typeof error === "object" && error !== null && "code" in error && error.code === "57014") {
    return "timeout";
  }
  return "error";
}

export function createSearchConcurrencyLimiter(limit: number): (
  signal: AbortSignal | undefined,
  deadlineAt: number,
) => Promise<() => void> {
  let active = 0;
  const waiters: Array<{
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: Error) => void;
    readonly signal?: AbortSignal;
    timer: ReturnType<typeof setTimeout>;
    onAbort?: () => void;
  }> = [];

  const releaseFactory = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (waiters.length > 0) {
        const next = waiters.shift()!;
        clearTimeout(next.timer);
        next.signal?.removeEventListener("abort", next.onAbort!);
        next.resolve(releaseFactory());
        return;
      }
      active -= 1;
    };
  };

  return (signal, deadlineAt) => {
    if (signal?.aborted) return Promise.reject(new SearchDeadlineError("search request was cancelled"));
    if (Date.now() >= deadlineAt) return Promise.reject(new SearchDeadlineError("search request deadline exceeded"));
    if (active < limit) {
      active += 1;
      return Promise.resolve(releaseFactory());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => {
          removeWaiter(waiter);
          reject(new SearchDeadlineError("search request deadline exceeded while queued"));
        }, Math.max(1, deadlineAt - Date.now())),
        onAbort: undefined as (() => void) | undefined,
      };
      waiter.onAbort = () => {
        removeWaiter(waiter);
        reject(new SearchDeadlineError("search request was cancelled while queued"));
      };
      const removeWaiter = (value: typeof waiter) => {
        const index = waiters.indexOf(value);
        if (index >= 0) waiters.splice(index, 1);
        clearTimeout(value.timer);
        value.signal?.removeEventListener("abort", value.onAbort!);
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      waiters.push(waiter);
    });
  };
}

export function resolveEventTypes(params: CogitoSearchParams): string[] {
  const legacy = splitCommaList(params.event_types);
  const resolved = legacy ?? eventTypesForSearchCategories(
    parseSearchEventCategories(params.event_categories) ??
      [...DEFAULT_SEARCH_CATEGORIES],
  );
  if (params.include_turn_summaries && !resolved.includes("turn_summary")) {
    resolved.push("turn_summary");
  }
  return resolved;
}

function splitCommaList(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : null;
}
