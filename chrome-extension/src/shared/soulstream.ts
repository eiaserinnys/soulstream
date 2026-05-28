import {
  buildCreateSessionRequest,
  buildSessionEndpoint,
  type CreateSessionResponse,
  type ExtensionConfig,
} from "./schema.js";

export interface SendPageActionResult {
  agentSessionId: string;
  nodeId?: string;
}

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  input: string,
  init: {
    method: "POST";
    credentials: "include";
    headers: Record<string, string>;
    body: string;
  },
) => Promise<FetchLikeResponse>;

export function sessionHeaders(config: ExtensionConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.bearerToken) headers.Authorization = `Bearer ${config.bearerToken}`;
  return headers;
}

export function extractErrorMessage(status: number, body: unknown, fallbackText: string): string {
  if (typeof body === "string" && body.trim()) return body.trim();
  if (isRecord(body)) {
    const detail = body.detail;
    if (typeof detail === "string") return detail;
    if (isRecord(detail)) {
      const error = detail.error;
      if (isRecord(error) && typeof error.message === "string") return error.message;
    }
    const error = body.error;
    if (typeof error === "string") return error;
    if (isRecord(error) && typeof error.message === "string") return error.message;
  }
  return fallbackText || `Soulstream request failed with HTTP ${status}`;
}

export async function sendSessionRequest(
  config: ExtensionConfig,
  prompt: string,
  fetchImpl: FetchLike,
): Promise<SendPageActionResult> {
  const endpoint = buildSessionEndpoint(config.baseUrl);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    credentials: "include",
    headers: sessionHeaders(config),
    body: JSON.stringify(buildCreateSessionRequest(config, prompt)),
  });

  if (!response.ok) {
    let parsed: unknown = "";
    let text = "";
    try {
      parsed = await response.json();
    } catch {
      text = await response.text().catch(() => "");
      parsed = text;
    }
    throw new Error(extractErrorMessage(response.status, parsed, text));
  }

  const data = await response.json();
  if (!isCreateSessionResponse(data)) {
    throw new Error("Soulstream returned an invalid session response");
  }
  return {
    agentSessionId: data.agentSessionId,
    nodeId: data.nodeId,
  };
}

function isCreateSessionResponse(value: unknown): value is CreateSessionResponse {
  return isRecord(value) && typeof value.agentSessionId === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
