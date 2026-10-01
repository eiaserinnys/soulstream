import {
  capturePlannerDescriptionProjection,
  patchPlannerDescriptionProjection,
} from './planner-description-projection';
import { findPlannerFolderProjection } from './planner-mutation-projection';
import type { PlannerPageMutationSettlement } from './planner-page-mutation';

interface OwnerLifecycle {
  activeTokens: Set<number>;
  needsRevalidation: boolean;
  latestAppliedSuccessToken: number | null;
}

export interface PlannerDescriptionMutationState {
  readonly activeTokens: readonly number[];
  readonly needsRevalidation: boolean;
}

const lifecycleByOwner = new Map<string, OwnerLifecycle>();
let nextToken = 0;

export function beginPlannerDescriptionMutation(
  scopeGeneration: string,
  ownerFolderPageId: string,
): PlannerPageMutationSettlement {
  const key = ownerKey(scopeGeneration, ownerFolderPageId);
  const lifecycle = lifecycleByOwner.get(key) ?? {
    activeTokens: new Set<number>(),
    needsRevalidation: false,
    latestAppliedSuccessToken: null,
  };
  const token = ++nextToken;
  lifecycle.activeTokens.add(token);
  lifecycleByOwner.set(key, lifecycle);

  return {
    canApply: () => preferredToken(lifecycle) === token,
    restore: (before, current) => {
      if (preferredToken(lifecycle) !== token
        || (lifecycle.latestAppliedSuccessToken ?? token) > token) return null;
      const original = findPlannerFolderProjection(before, ownerFolderPageId);
      return original ? patchPlannerDescriptionProjection(
        current,
        ownerFolderPageId,
        capturePlannerDescriptionProjection(original),
      ) : null;
    },
    onSuccess: (applied) => {
      if (applied) lifecycle.latestAppliedSuccessToken = Math.max(
        lifecycle.latestAppliedSuccessToken ?? token,
        token,
      );
      if (!applied || lifecycle.activeTokens.size > 1) lifecycle.needsRevalidation = true;
    },
    onFailure: () => { lifecycle.needsRevalidation = true; },
    onRevalidated: (applied) => {
      if (applied && lifecycle.activeTokens.size === 1 && lifecycle.activeTokens.has(token)) {
        lifecycle.needsRevalidation = false;
      }
    },
    retire: () => {
      lifecycle.activeTokens.delete(token);
      const needsFinal = lifecycle.activeTokens.size === 0 && lifecycle.needsRevalidation;
      if (!needsFinal) cleanupResolvedOwner(key, lifecycle);
      return needsFinal;
    },
    canApplyFinalRevalidation: () => lifecycle.activeTokens.size === 0,
    onFinalRevalidated: (applied) => {
      if (applied && lifecycle.activeTokens.size === 0) lifecycle.needsRevalidation = false;
      cleanupResolvedOwner(key, lifecycle);
    },
    abandon: () => {
      if (lifecycle.activeTokens.size === 0) lifecycleByOwner.delete(key);
    },
  };
}

export function getPlannerDescriptionMutationStateForTest(
  scopeGeneration: string,
  ownerFolderPageId: string,
): PlannerDescriptionMutationState {
  const lifecycle = lifecycleByOwner.get(ownerKey(scopeGeneration, ownerFolderPageId));
  return {
    activeTokens: lifecycle ? [...lifecycle.activeTokens].sort((a, b) => a - b) : [],
    needsRevalidation: lifecycle?.needsRevalidation ?? false,
  };
}

function preferredToken(lifecycle: OwnerLifecycle): number | undefined {
  let preferred: number | undefined;
  for (const token of lifecycle.activeTokens) {
    if (preferred === undefined || token > preferred) preferred = token;
  }
  return preferred;
}

function cleanupResolvedOwner(key: string, lifecycle: OwnerLifecycle): void {
  if (lifecycle.activeTokens.size === 0 && !lifecycle.needsRevalidation) {
    lifecycleByOwner.delete(key);
  }
}

function ownerKey(scopeGeneration: string, ownerFolderPageId: string): string {
  return `${scopeGeneration}:${ownerFolderPageId}`;
}
