const tails = new Map<string, Promise<void>>();

/** Serializes destructive host-side mutations for one session directory. */
export async function withRunnerSessionMutationLock<T>(
  sessionDirectory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(sessionDirectory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  tails.set(sessionDirectory, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(sessionDirectory) === tail) tails.delete(sessionDirectory);
  }
}
