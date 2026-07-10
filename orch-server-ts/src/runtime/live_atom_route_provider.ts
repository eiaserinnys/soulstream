import type {
  AtomHttpClient,
  AtomHttpRequest,
  AtomHttpResponse,
} from "../atom/atom_routes.js";

export type LiveAtomHttpClientFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type CreateLiveAtomHttpClientOptions = {
  readonly fetch?: LiveAtomHttpClientFetch;
  readonly timeoutMs?: number;
};

const DEFAULT_ATOM_HTTP_TIMEOUT_MS = 5_000;

export function createLiveAtomHttpClient(
  options: CreateLiveAtomHttpClientOptions = {},
): AtomHttpClient {
  const fetch = options.fetch ?? globalThis.fetch;
  if (typeof fetch !== "function") {
    throw new Error("global fetch is required for live Atom HTTP client");
  }
  const timeoutMs = normalizeAtomHttpTimeoutMs(options.timeoutMs);

  return {
    get: (request) => sendAtomGet(fetch, timeoutMs, request),
  };
}

async function sendAtomGet(
  fetch: LiveAtomHttpClientFetch,
  timeoutMs: number,
  request: AtomHttpRequest,
): Promise<AtomHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: "GET",
      headers: request.headers,
      signal: controller.signal,
    });
    return {
      statusCode: response.status,
      body: await readAtomResponseBody(response),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readAtomResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    response.ok ||
    contentType.includes("application/json") ||
    contentType.includes("+json")
  ) {
    return response.json();
  }
  return response.text();
}

function normalizeAtomHttpTimeoutMs(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? DEFAULT_ATOM_HTTP_TIMEOUT_MS;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`Atom HTTP timeoutMs must be a positive integer: ${resolved}`);
  }
  return resolved;
}
