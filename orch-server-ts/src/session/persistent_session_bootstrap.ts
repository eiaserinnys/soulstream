import { createHash } from "node:crypto";

import { PersistentSessionApiError } from "./persistent_session_api_error.js";
import type { PersistentCreateDefaults } from "./persistent_session_settings_service.js";

export const BOOTSTRAP_NO_MODEL_MESSAGE =
  "쓸 수 있는 모델이 없습니다. 코딩 에이전트를 먼저 연결해 주십시오.";
export const BOOTSTRAP_NO_AGENT_MESSAGE = "기본 영구 세션에 쓸 에이전트가 정해져 있지 않습니다.";
const FALLBACK_DISPLAY_NAME = "PAS";

/** Runs one task per key at a time; callers that overlap receive the first caller's result. */
export class SingleFlightByKey<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  run(key: string, task: () => Promise<T>): Promise<T> {
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const started = task().finally(() => {
      if (this.inFlight.get(key) === started) this.inFlight.delete(key);
    });
    this.inFlight.set(key, started);
    return started;
  }
}

/** Opaque per-user key for the single flight; the caller's address never reaches a log or a map key. */
export function bootstrapUserKey(callerId: string | null): string {
  if (callerId === null || callerId.trim().length === 0) return "anonymous";
  return createHash("sha256").update(callerId.trim().toLowerCase()).digest("hex").slice(0, 16);
}

/** The body is absent or an empty object; any key is refused the way the create path refuses it. */
export function parseBootstrapBody(input: unknown): void {
  if (input === undefined || input === null) return;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new PersistentSessionApiError(400, "INVALID_REQUEST", "Request body must be a JSON object");
  }
  const unknown = Object.keys(input)[0];
  if (unknown !== undefined) {
    throw new PersistentSessionApiError(422, "INVALID_REQUEST", `${unknown} is not supported`);
  }
}

/** 「ソ・ソヨン(PAS)」 becomes 「ソ・ソヨン」. A profile without a usable name becomes 「PAS」. */
export function bootstrapDisplayName(profileName: unknown): string {
  if (typeof profileName !== "string") return FALLBACK_DISPLAY_NAME;
  const name = profileName.trim().replace(/\s*\(PAS\)$/, "");
  return name || FALLBACK_DISPLAY_NAME;
}

/**
 * The first refusal that stands between the defaults and a create call, or null when the
 * defaults are complete. Narrows the defaults so the create body needs no further checks.
 */
export function bootstrapRefusal(defaults: PersistentCreateDefaults): PersistentSessionApiError | null {
  if (defaults.unavailable_reason !== null) {
    return new PersistentSessionApiError(409, "bootstrap_unavailable", defaults.unavailable_reason);
  }
  if (defaults.settings.default_model.model_preset === null) {
    return new PersistentSessionApiError(409, "bootstrap_unavailable", BOOTSTRAP_NO_MODEL_MESSAGE);
  }
  if (defaults.preferred_agent_id === null) {
    return new PersistentSessionApiError(409, "bootstrap_unavailable", BOOTSTRAP_NO_AGENT_MESSAGE);
  }
  return null;
}
