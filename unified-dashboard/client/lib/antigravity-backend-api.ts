import type { useTranslation } from "react-i18next";

export const ANTIGRAVITY_ACKNOWLEDGEMENT = "인지했습니다"; // i18n-ignore: 서버가 요구하는 고정 승인 값
const ENDPOINT = "/api/admin/settings/antigravity-backend";

export type AntigravityBackendPayload = {
  value: { enabled: boolean; acknowledged_at?: string };
  version: number;
  source: "default" | "settings";
};

export class AntigravityBackendRequestError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "AntigravityBackendRequestError";
  }
}

async function send(request: typeof fetch, method: "GET" | "PUT", body?: unknown): Promise<AntigravityBackendPayload> {
  const response = await request(ENDPOINT, {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new AntigravityBackendRequestError(response.status);
  return await response.json() as AntigravityBackendPayload;
}

export const getAntigravityBackend = (request: typeof fetch) =>
  send(request, "GET");

export const putAntigravityBackend = (request: typeof fetch, input: { enabled: boolean; expectedVersion: number }) =>
  send(request, "PUT", {
    value: input.enabled ? { enabled: true, acknowledgement: ANTIGRAVITY_ACKNOWLEDGEMENT } : { enabled: false },
    expectedVersion: input.expectedVersion,
  });

export function formatAntigravitySaveError(error: unknown, t: ReturnType<typeof useTranslation>["t"]): string {
  if (error instanceof AntigravityBackendRequestError) {
    return error.status === 409
      ? t("accounts.antigravity.conflict")
      : t("accounts.antigravity.saveError", { status: error.status });
  }
  return error instanceof Error ? error.message : String(error);
}
