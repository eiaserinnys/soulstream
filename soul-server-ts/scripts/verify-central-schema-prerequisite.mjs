const HEALTH_PATH = "/api/health";

/** One health attempt may take this long before it is treated as not up yet. */
const ATTEMPT_TIMEOUT_MS = 10_000;
/** Pause between attempts; a refused connection or 502 answers instantly. */
const RETRY_INTERVAL_MS = 5_000;
/** Whole-hook budget; the longest observed central restart was 338s. */
const TOTAL_BUDGET_MS = 360_000;
/** Answers of a peer that has not finished (re)starting yet. */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/**
 * Polls central health until the database schema generation matches the
 * release manifest. A central restart longer than the budget still fails the
 * build with the same errors as the single-shot check.
 */
export async function verifyCentralSchemaPrerequisite({
  upstreamUrl,
  schemaGeneration,
  fetchImpl = fetch,
  sleepImpl = sleep,
  nowImpl = Date.now,
  attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
  retryIntervalMs = RETRY_INTERVAL_MS,
  totalBudgetMs = TOTAL_BUDGET_MS,
}) {
  const required = parseSchemaGeneration(schemaGeneration);
  const healthUrl = centralHealthUrl(upstreamUrl);
  const deadlineMs = nowImpl() + totalBudgetMs;
  for (;;) {
    const remainingMs = deadlineMs - nowImpl();
    const outcome = await probeCentralHealth(healthUrl, required, {
      fetchImpl,
      timeoutMs: Math.max(1, Math.min(attemptTimeoutMs, remainingMs)),
    });
    if (outcome.schema !== undefined) return outcome.schema;
    if (!outcome.retryable) throw outcome.error;
    const waitMs = deadlineMs - nowImpl();
    if (waitMs <= 0) throw outcome.error;
    await sleepImpl(Math.min(retryIntervalMs, waitMs));
    if (nowImpl() >= deadlineMs) throw outcome.error;
  }
}

async function probeCentralHealth(healthUrl, required, { fetchImpl, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(healthUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Connection refused/reset and fetch timeouts mean the peer is not up yet.
    return { retryable: true, error };
  }
  if (!response.ok) {
    return {
      retryable: RETRYABLE_STATUSES.has(response.status),
      error: new Error(
        `central database schema prerequisite mismatch: health returned ${response.status}`,
      ),
    };
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    return { retryable: true, error };
  }
  const actual = body?.database_schema;
  if (
    body?.status !== "ok"
    || actual?.migration_id !== required.migrationId
    || actual?.checksum !== required.checksum
  ) {
    return {
      retryable: true,
      error: new Error(
        "central database schema prerequisite mismatch: target migration is not active",
      ),
    };
  }
  return { schema: actual };
}

function sleep(delayMs) {
  return new Promise((resolve) => { setTimeout(resolve, delayMs); });
}

function parseSchemaGeneration(value) {
  if (typeof value !== "string") {
    throw new Error("release manifest schema_generation is required");
  }
  const [migrationId, checksum] = value.split(":", 3);
  if (!migrationId || !checksum) {
    throw new Error("release manifest schema_generation is malformed");
  }
  return { migrationId, checksum };
}

function centralHealthUrl(upstreamUrl) {
  const url = new URL(upstreamUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else throw new Error("SOULSTREAM_UPSTREAM_URL must be ws:// or wss://");
  url.pathname = HEALTH_PATH;
  url.search = "";
  url.hash = "";
  return url;
}
