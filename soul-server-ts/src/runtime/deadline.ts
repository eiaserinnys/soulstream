/**
 * Canonical deadline wrapper for awaits that would otherwise be unbounded.
 *
 * The underlying operation is *not* cancelled — JavaScript promises have no
 * cancellation — so callers that must not restart a still-running operation
 * have to track it themselves. What this guarantees is only that the *waiter*
 * is released, which is what keeps a stalled dependency from wedging the
 * caller and everything queued behind it.
 */
export async function withDeadline<T>(
  pending: Promise<T>,
  timeoutMs: number,
  makeError: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(makeError()), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
