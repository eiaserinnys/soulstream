export interface BoardYjsQuiescedApplyPreflightInput {
  apply: boolean;
  quiescedAcknowledged: boolean;
  orchHealthUrl: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

class OrchStillRespondingError extends Error {}
const EXPECTED_ORCH_HEALTH_URL = "http://127.0.0.1:5200/api/health";

/**
 * Apply is intentionally an offline maintenance operation. A loopback
 * connection refusal proves that the local orchestrator process is not
 * accepting traffic; timeouts and remote-network failures are ambiguous and
 * therefore fail closed.
 */
export async function assertBoardYjsQuiescedApplyPreflight(
  input: BoardYjsQuiescedApplyPreflightInput,
): Promise<void> {
  if (!input.apply) return;
  if (!input.quiescedAcknowledged) {
    throw new Error("Board Y.Doc apply requires explicit --quiesced acknowledgement");
  }
  if (!input.orchHealthUrl?.trim()) {
    throw new Error("Board Y.Doc apply requires --orch-health-url");
  }
  const url = new URL(input.orchHealthUrl);
  if (url.href !== EXPECTED_ORCH_HEALTH_URL) {
    throw new Error(
      `Board Y.Doc apply health check must use the exact loopback endpoint ` +
        EXPECTED_ORCH_HEALTH_URL,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 3_000);
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      signal: controller.signal,
    });
    throw new OrchStillRespondingError(
      `Board Y.Doc host is still responding (${response.status}); stop orch before apply`,
    );
  } catch (error) {
    if (error instanceof OrchStillRespondingError) throw error;
    if (isConnectionRefused(error)) return;
    throw new Error(
      "Board Y.Doc apply could not prove that orch is stopped; expected local ECONNREFUSED",
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

function isConnectionRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const cause = "cause" in error ? error.cause : undefined;
  return Boolean(cause && typeof cause === "object" &&
    "code" in cause && cause.code === "ECONNREFUSED");
}
