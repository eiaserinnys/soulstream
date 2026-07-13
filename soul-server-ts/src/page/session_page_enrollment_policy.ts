export type SessionPageEnrollmentDecision =
  | { readonly kind: "explicit_page" }
  | { readonly kind: "daily" }
  | {
    readonly kind: "excluded";
    readonly reason: "runbook_container" | "non_human_source";
  };

export interface SessionPageEnrollmentInput {
  readonly hasPageAnchor: boolean;
  readonly containerKind: "folder" | "runbook" | null;
  readonly callerSource: string | null | undefined;
}

const HUMAN_DAILY_SOURCES = new Set(["browser", "soul-app"]);

/** Canonical enrollment policy for a newly created session's primary page projection. */
export function decideSessionPageEnrollment(
  input: SessionPageEnrollmentInput,
): SessionPageEnrollmentDecision {
  if (input.hasPageAnchor) return { kind: "explicit_page" };
  if (input.containerKind === "runbook") {
    return { kind: "excluded", reason: "runbook_container" };
  }
  if (input.callerSource && HUMAN_DAILY_SOURCES.has(input.callerSource)) {
    return { kind: "daily" };
  }
  return { kind: "excluded", reason: "non_human_source" };
}
