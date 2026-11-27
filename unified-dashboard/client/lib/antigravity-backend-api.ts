export const ANTIGRAVITY_ACKNOWLEDGEMENT = "인지했습니다";
const ENDPOINT = "/api/admin/settings/antigravity-backend";

export type AntigravityBackendPayload = {
  value: { enabled: boolean; acknowledged_at?: string };
  version: number;
  source: "default" | "settings";
};

export class AntigravityBackendRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AntigravityBackendRequestError";
  }
}

async function send(request: typeof fetch, method: "GET" | "PUT", body?: unknown, failure = "설정을 처리하지 못했습니다"): Promise<AntigravityBackendPayload> {
  const response = await request(ENDPOINT, {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new AntigravityBackendRequestError(
      response.status === 409 ? "설정이 다른 곳에서 바뀌어 다시 읽었습니다. 다시 시도해 주세요." : `${failure} (${response.status})`,
      response.status,
    );
  }
  return await response.json() as AntigravityBackendPayload;
}

export const getAntigravityBackend = (request: typeof fetch) =>
  send(request, "GET", undefined, "Antigravity 설정을 불러오지 못했습니다");

export const putAntigravityBackend = (request: typeof fetch, input: { enabled: boolean; expectedVersion: number }) =>
  send(request, "PUT", {
    value: input.enabled ? { enabled: true, acknowledgement: ANTIGRAVITY_ACKNOWLEDGEMENT } : { enabled: false },
    expectedVersion: input.expectedVersion,
  }, "설정을 저장하지 못했습니다");
