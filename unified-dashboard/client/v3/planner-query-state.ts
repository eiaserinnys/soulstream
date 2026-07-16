import { retainEqualValue } from "@seosoyoung/soul-ui";

import type { PlannerLoadState } from "./PlannerViews";

export function beginPlannerLoad<T>(
  current: PlannerLoadState<T>,
): PlannerLoadState<T> {
  if (current.data !== null) return current;
  if (current.status === "loading") return current;
  return { status: "loading", data: null, message: null };
}

type PlannerReadyState<T> = { status: "ready"; data: T; message: null };

export function completePlannerLoad<T extends object>(
  current: PlannerLoadState<T>,
  data: T,
): PlannerReadyState<T> {
  const next: PlannerReadyState<T> = { status: "ready", data, message: null };
  return current.status === "ready" ? retainEqualValue(current, next) : next;
}

export function failPlannerLoad<T extends object>(
  current: PlannerLoadState<T>,
  message: string,
): PlannerLoadState<T> {
  return retainEqualValue(current, { status: "error", data: current.data, message });
}

export async function loadConfirmedResult<T extends object>({
  previous,
  load,
  clearsVisibleContent,
}: {
  previous: T | null;
  load(): Promise<T>;
  clearsVisibleContent(current: T, next: T): boolean;
}): Promise<T> {
  const first = await load() as T;
  if (previous === null || !clearsVisibleContent(previous, first)) {
    return retainEqualValue(previous ?? undefined, first);
  }
  const confirmed = await load() as T;
  return retainEqualValue(previous, confirmed);
}
