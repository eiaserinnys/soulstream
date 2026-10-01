export async function runPlannerMutationTransaction<TSnapshot, TResult>(input: {
  capture(): TSnapshot;
  project(snapshot: TSnapshot): void;
  mutate(): Promise<TResult>;
  merge?(result: TResult, snapshot: TSnapshot): void;
  restore(snapshot: TSnapshot): void;
  revalidate?(error: unknown, snapshot: TSnapshot): Promise<unknown> | unknown;
}): Promise<TResult> {
  const before = input.capture();
  input.project(before);
  try {
    const result = await input.mutate();
    input.merge?.(result, before);
    return result;
  } catch (error) {
    input.restore(before);
    await input.revalidate?.(error, before);
    throw error;
  }
}
