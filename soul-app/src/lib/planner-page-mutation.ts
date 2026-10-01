import type { PageReadResult } from '../api/pageEndpoints';
import type { PlannerProjectionState } from './planner-mutation-projection';
import { runPlannerMutationTransaction } from './planner-mutation-transaction';

export interface PlannerPageMutationSettlement {
  canApply(): boolean;
  restore(
    before: PlannerProjectionState,
    current: PlannerProjectionState,
  ): PlannerProjectionState | null;
  onSuccess(applied: boolean): void;
  onFailure(): void;
  onRevalidated(applied: boolean): void;
  retire(): boolean;
  canApplyFinalRevalidation(): boolean;
  onFinalRevalidated(applied: boolean): void;
  abandon(): void;
}

export interface PlannerPageMutationInput<TResult> {
  source?: 'page' | 'folder';
  project(before: PlannerProjectionState): PlannerProjectionState;
  mutate(): Promise<TResult>;
  merge?(result: TResult): void;
  reconcile?(result: PageReadResult): void;
  settlement?: PlannerPageMutationSettlement;
}

export function runPlannerPageMutation<TResult>(runtime: {
  capture(): PlannerProjectionState;
  apply(state: PlannerProjectionState): void;
  isCurrent(): boolean;
  markChanged(source: 'page' | 'folder'): void;
  revalidate(canApply?: () => boolean, reconcile?: (result: PageReadResult) => void): Promise<boolean>;
}, input: PlannerPageMutationInput<TResult>): Promise<TResult> {
  const settlement = input.settlement;
  const transaction = runPlannerMutationTransaction({
    capture: runtime.capture,
    project: (before) => runtime.apply(input.project(before)),
    mutate: input.mutate,
    merge: (result) => {
      const applied = runtime.isCurrent() && (!settlement || settlement.canApply());
      if (applied) {
        input.merge?.(result);
        runtime.markChanged(input.source ?? 'page');
      }
      settlement?.onSuccess(applied);
    },
    restore: (before) => {
      if (!runtime.isCurrent()) return;
      settlement?.onFailure();
      const next = settlement
        ? settlement.restore(before, runtime.capture())
        : before;
      if (next) runtime.apply(next);
    },
    revalidate: async () => {
      const applied = await runtime.revalidate(settlement?.canApply, input.reconcile);
      settlement?.onRevalidated(applied);
    },
  });
  if (!settlement) return transaction;
  return transaction.finally(async () => {
    if (!settlement.retire()) return;
    if (!runtime.isCurrent()) {
      settlement.abandon();
      return;
    }
    const applied = await runtime.revalidate(
      settlement.canApplyFinalRevalidation,
      input.reconcile,
    );
    settlement.onFinalRevalidated(applied);
  });
}
