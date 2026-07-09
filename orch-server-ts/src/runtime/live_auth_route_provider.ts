import type {
  AuthHttpClient,
  AuthHttpGetRequest,
  AuthHttpPostRequest,
  AuthHttpResponse,
} from "../auth/auth_routes.js";

export type LiveAuthHttpClientFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type CreateLiveAuthHttpClientOptions = {
  readonly fetch?: LiveAuthHttpClientFetch;
  readonly timeoutMs?: number;
};

const DEFAULT_AUTH_HTTP_TIMEOUT_MS = 5_000;

export function createLiveAuthHttpClient(
  options: CreateLiveAuthHttpClientOptions = {},
): AuthHttpClient {
  const fetch = options.fetch ?? globalThis.fetch;
  if (typeof fetch !== "function") {
    throw new Error("global fetch is required for live auth HTTP client");
  }
  const timeoutMs = normalizeAuthHttpTimeoutMs(options.timeoutMs);

  return {
    post: (request) => sendAuthPost(fetch, timeoutMs, request),
    get: (request) => sendAuthGet(fetch, timeoutMs, request),
  };
}

async function sendAuthPost(
  fetch: LiveAuthHttpClientFetch,
  timeoutMs: number,
  request: AuthHttpPostRequest,
): Promise<AuthHttpResponse> {
  return sendAuthRequest(fetch, timeoutMs, request.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(request.data),
  });
}

async function sendAuthGet(
  fetch: LiveAuthHttpClientFetch,
  timeoutMs: number,
  request: AuthHttpGetRequest,
): Promise<AuthHttpResponse> {
  return sendAuthRequest(fetch, timeoutMs, request.url, {
    method: "GET",
    headers: request.headers,
  });
}

async function sendAuthRequest(
  fetch: LiveAuthHttpClientFetch,
  timeoutMs: number,
  url: string,
  init: RequestInit,
): Promise<AuthHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (response.status !== 200) {
      return {
        statusCode: response.status,
        body: await response.text(),
      };
    }
    return {
      statusCode: response.status,
      body: await response.json(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAuthHttpTimeoutMs(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? DEFAULT_AUTH_HTTP_TIMEOUT_MS;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`Auth HTTP timeoutMs must be a positive integer: ${resolved}`);
  }
  return resolved;
}
