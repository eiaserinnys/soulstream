import type { SessionDeliveryNotificationOutboxRow } from "@soulstream/wire-schema/session-delivery";
import { localInternalMcpUrlFromEnv } from "../src/mcp/endpoint_paths.js";

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 100;

export interface NotificationDlqClient {
  listDeadLetters(limit?: number): Promise<SessionDeliveryNotificationOutboxRow[]>;
  requeueDeadLetter(deliveryId: string): Promise<SessionDeliveryNotificationOutboxRow | null>;
}

export function createNotificationDlqClient(
  env: NodeJS.ProcessEnv = process.env,
): NotificationDlqClient {
  const authBearerToken = requiredEnvironmentVariable(env, "AUTH_BEARER_TOKEN");
  const baseUrl = localInternalMcpUrlFromEnv(env);

  const request = async (path: string, init: RequestInit): Promise<unknown> => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${authBearerToken}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `local soul-server notification DLQ request failed: HTTP ${response.status}${errorDetail(text)}`,
      );
    }
    return text ? parseJson(text) : null;
  };

  return {
    async listDeadLetters(limit = DEFAULT_LIMIT) {
      const payload = await request(
        `/notification-dlq/dead-letters?limit=${limit}`,
        { method: "GET" },
      );
      return rowsOf(payload);
    },
    async requeueDeadLetter(deliveryId: string) {
      const payload = await request("/notification-dlq/requeue", {
        method: "POST",
        body: JSON.stringify({ deliveryId }),
      });
      return rowOf(payload);
    },
  };
}

export function readArgument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function requiredEnvironmentVariable(
  env: NodeJS.ProcessEnv,
  name: "AUTH_BEARER_TOKEN",
): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function rowsOf(payload: unknown): SessionDeliveryNotificationOutboxRow[] {
  const rows = isRecord(payload) ? payload.rows : undefined;
  if (!Array.isArray(rows)) {
    throw new Error("local soul-server notification DLQ response has no rows");
  }
  return rows as SessionDeliveryNotificationOutboxRow[];
}

function rowOf(payload: unknown): SessionDeliveryNotificationOutboxRow | null {
  const row = isRecord(payload) ? payload.row : undefined;
  if (row === undefined || row === null) return null;
  return row as SessionDeliveryNotificationOutboxRow;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("local soul-server returned a non-JSON notification DLQ response");
  }
}

function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && typeof parsed.error === "string") {
      return ` (${parsed.error})`;
    }
  } catch {
    // 본문이 JSON이 아니면 상태 코드만 남긴다.
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
