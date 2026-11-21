export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const ANTHROPIC_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

export function parseProfileIdentity(payload: unknown): {
  accountUuid: string | null;
  email: string | null;
  plan: string | null;
} {
  return {
    accountUuid: extractAccountUuid(payload),
    email: findString(payload, new Set(["email", "emailAddress", "email_address"])),
    plan: findString(
      payload,
      new Set(["plan", "subscriptionType", "subscription_type", "planType", "plan_type"]),
    ),
  };
}

function extractAccountUuid(value: unknown): string | null {
  if (isRecord(value) && isRecord(value.account) && typeof value.account.uuid === "string") {
    const trimmed = value.account.uuid.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return findString(
    value,
    new Set(["accountUuid", "account_uuid", "uuid", "userUuid", "user_uuid"]),
  );
}

function findString(value: unknown, keys: Set<string>): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, keys);
      if (found) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && typeof item === "string" && item.trim().length > 0) {
      return item.trim();
    }
  }
  for (const item of Object.values(value)) {
    const found = findString(item, keys);
    if (found) return found;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
