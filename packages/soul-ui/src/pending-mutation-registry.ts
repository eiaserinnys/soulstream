export interface PendingMutationHandle {
  setPending(pending: boolean): void;
  dispose(): void;
}

const pendingMutations = new Set<symbol>();
const idleListeners = new Set<() => void>();

export function createPendingMutationHandle(): PendingMutationHandle {
  const id = Symbol("pending-mutation");
  let disposed = false;
  return {
    setPending(pending) {
      if (disposed) return;
      if (pending) {
        pendingMutations.add(id);
      } else {
        pendingMutations.delete(id);
        notifyIfIdle();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingMutations.delete(id);
      notifyIfIdle();
    },
  };
}

export function hasPendingDashboardMutations(): boolean {
  return pendingMutations.size > 0;
}

export async function waitForDashboardMutationsToFlush(
  timeoutMs = 10_000,
): Promise<boolean> {
  if (!hasPendingDashboardMutations()) return true;
  return await new Promise<boolean>((resolve) => {
    const onIdle = () => {
      clearTimeout(timeout);
      idleListeners.delete(onIdle);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      idleListeners.delete(onIdle);
      resolve(false);
    }, timeoutMs);
    idleListeners.add(onIdle);
  });
}

function notifyIfIdle(): void {
  if (pendingMutations.size > 0) return;
  for (const listener of [...idleListeners]) listener();
}
