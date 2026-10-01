import { ApiHttpError } from './clientCore';

const PAGE_MUTATION_VERSION_CONFLICT = 'PAGE_MUTATION_VERSION_CONFLICT';

export async function retryPageMutationVersionConflict<TState, TResult>(
  readFresh: () => Promise<TState>,
  mutate: (state: TState) => Promise<TResult>,
): Promise<TResult> {
  const initial = await readFresh();
  try {
    return await mutate(initial);
  } catch (error) {
    if (!isPageMutationVersionConflict(error)) throw error;
  }
  return mutate(await readFresh());
}

function isPageMutationVersionConflict(error: unknown): boolean {
  if (!(error instanceof ApiHttpError) || error.status !== 409) return false;
  try {
    const body = JSON.parse(error.body) as {
      detail?: { error?: { code?: unknown } };
    };
    return body.detail?.error?.code === PAGE_MUTATION_VERSION_CONFLICT;
  } catch {
    return false;
  }
}
