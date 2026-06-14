import {
  asArray,
  asString,
  firstString,
} from "./claude_sdk_helpers.js";

const EDE_DIAGNOSTIC_MARKER = "[ede_diagnostic]";

export function isEdeDiagnosticErrorText(
  text: string | undefined,
  options: { requirePrefix?: boolean } = {},
): boolean {
  if (!text) return false;
  return options.requirePrefix
    ? text.startsWith(EDE_DIAGNOSTIC_MARKER)
    : text.includes(EDE_DIAGNOSTIC_MARKER);
}

export function isRecoverableExecutionDiagnostic(message: Record<string, unknown>): boolean {
  if (message.subtype !== "error_during_execution") return false;
  const firstError = firstString(asArray(message.errors));
  return isEdeDiagnosticErrorText(firstError, { requirePrefix: true });
}

export function resultErrorCode(message: Record<string, unknown>): string {
  const explicitCode = asString(message.error_code) ?? asString(message.errorCode);
  if (explicitCode) return explicitCode;

  const subtype = asString(message.subtype);
  if (message.is_error === true && subtype === "success") {
    return "claude_sdk_result_error";
  }
  return subtype ?? "claude_sdk_result_error";
}
