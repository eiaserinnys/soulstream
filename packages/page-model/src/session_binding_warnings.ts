export type SessionBindingPageState = "pending" | "bound" | "manual_repair";
export type SessionBindingLegacyState = "pending" | "completed" | "manual_repair";

export type SessionBindingWarningCode =
  | "PAGE_BINDING_PENDING"
  | "PAGE_BINDING_MANUAL_REPAIR"
  | "LEGACY_PROJECTION_PENDING";

export interface SessionBindingWarning {
  code: SessionBindingWarningCode;
  message: string;
}

export interface SessionBindingWarningState {
  pageState: SessionBindingPageState | null | undefined;
  legacyState: SessionBindingLegacyState | null | undefined;
}

const WARNING_MESSAGES: Readonly<Record<SessionBindingWarningCode, string>> = {
  PAGE_BINDING_PENDING:
    "The session was created. Page binding is pending and will retry automatically.",
  PAGE_BINDING_MANUAL_REPAIR:
    "The session was created, but its page block could not be converted automatically. Manual repair is required.",
  LEGACY_PROJECTION_PENDING:
    "The session was created. Its legacy folder projection is pending and will retry automatically.",
};

const WARNING_CODES = new Set<SessionBindingWarningCode>(
  Object.keys(WARNING_MESSAGES) as SessionBindingWarningCode[],
);

export function projectSessionBindingWarnings(
  state: SessionBindingWarningState,
): SessionBindingWarning[] {
  const warnings: SessionBindingWarning[] = [];
  if (state.pageState === "pending") {
    warnings.push(warning("PAGE_BINDING_PENDING"));
  } else if (state.pageState === "manual_repair") {
    warnings.push(warning("PAGE_BINDING_MANUAL_REPAIR"));
  }
  if (state.legacyState === "pending") {
    warnings.push(warning("LEGACY_PROJECTION_PENDING"));
  } else if (state.legacyState === "manual_repair") {
    warnings.push({
      code: "LEGACY_PROJECTION_PENDING",
      message:
        "The session was created, but its legacy folder projection could not be completed automatically. Manual repair is required.",
    });
  }
  return warnings;
}

export function normalizeSessionBindingWarnings(value: unknown): SessionBindingWarning[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.code !== "string"
      || !WARNING_CODES.has(record.code as SessionBindingWarningCode)
      || typeof record.message !== "string"
    ) {
      return [];
    }
    return [{
      code: record.code as SessionBindingWarningCode,
      message: record.message,
    }];
  });
}

function warning(code: SessionBindingWarningCode): SessionBindingWarning {
  return { code, message: WARNING_MESSAGES[code] };
}
