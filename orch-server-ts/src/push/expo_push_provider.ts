import type {
  PushNotificationProvider,
  PushSendResult,
} from "./push_notifier.js";

export type ExpoPushFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type CreateExpoPushProviderOptions = {
  readonly fetch?: ExpoPushFetch;
  readonly timeoutMs?: number;
};

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const DEFAULT_TIMEOUT_MS = 10_000;

export function createExpoPushProvider(
  options: CreateExpoPushProviderOptions = {},
): PushNotificationProvider {
  const fetch = options.fetch ?? globalThis.fetch;
  if (typeof fetch !== "function") {
    throw new Error("global fetch is required for Expo push notifications");
  }
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  return {
    send: (token, title, body, data) =>
      sendExpoPush(fetch, timeoutMs, token, title, body, data),
  };
}

async function sendExpoPush(
  fetch: ExpoPushFetch,
  timeoutMs: number,
  token: string,
  title: string,
  body: string,
  data: Readonly<Record<string, unknown>>,
): Promise<PushSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: token,
        title,
        body,
        data,
        sound: "default",
        priority: "high",
      }),
      signal: controller.signal,
    });
    return parseExpoPushResponse(await response.json());
  } catch (error) {
    return {
      ok: false,
      invalidToken: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function parseExpoPushResponse(payload: unknown): PushSendResult {
  const data = recordValue(payload)?.data;
  const ticket = Array.isArray(data) ? recordValue(data[0]) : recordValue(data);
  if (ticket === undefined) {
    return { ok: false, invalidToken: false, error: "unexpected response shape" };
  }
  if (ticket.status !== "error") return { ok: true, invalidToken: false };
  const details = recordValue(ticket.details);
  const error = stringValue(details?.error, ticket.message) || "unknown";
  return {
    ok: false,
    invalidToken: error === "DeviceNotRegistered",
    error,
  };
}

function normalizeTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Expo push timeoutMs must be a positive integer: ${timeoutMs}`);
  }
  return timeoutMs;
}

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
