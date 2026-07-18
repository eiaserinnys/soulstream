const PROJECTION_RETRY_DELAYS_MS = [100, 250, 500] as const;

/**
 * Retries a read while an asynchronously-created projection still reports 404.
 * Other responses are final, including successful empty payloads.
 */
export async function fetchWithProjectionRetry(
  fetchOnce: (signal?: AbortSignal) => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; attempt <= PROJECTION_RETRY_DELAYS_MS.length; attempt += 1) {
    throwIfAborted(signal);
    const response = await fetchOnce(signal);
    if (response.status !== 404) return response;

    const retryDelay = PROJECTION_RETRY_DELAYS_MS[attempt];
    if (retryDelay === undefined) return response;
    await waitForProjection(retryDelay, signal);
  }
  throw new Error("Projection retry exhausted without a response");
}

function waitForProjection(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}
