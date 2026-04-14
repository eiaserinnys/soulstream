/**
 * Normalize user input to a valid HTTPS URL.
 * - Replaces `http://` with `https://`
 * - Prepends `https://` if no scheme is present
 * - Validates URL structure
 * @throws if the resulting URL is invalid
 */
export function normalizeUrl(input: string): string {
  let cleaned = input.trim();
  if (cleaned.startsWith("http://")) {
    cleaned = cleaned.replace(/^http:\/\//, "https://");
  }
  const fullUrl = cleaned.startsWith("https://")
    ? cleaned
    : `https://${cleaned}`;
  new URL(fullUrl); // throws TypeError if invalid
  return fullUrl;
}

/**
 * Check if a server URL is reachable.
 * Uses no-cors HEAD request — only verifies network reachability,
 * not HTTP status (opaque response limitation).
 */
export async function checkReachability(
  url: string,
  timeoutMs: number = 5000,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // no-cors: opaque response, we can only detect network failure / DNS failure.
    // A proper /health endpoint with CORS would be more reliable, but this is
    // sufficient for initial connectivity checks.
    await fetch(url, {
      method: "HEAD",
      mode: "no-cors",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
