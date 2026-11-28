export type SessionPageEnrollmentDecision =
  | { readonly kind: "explicit_page" }
  | { readonly kind: "excluded"; readonly reason: "non_human_source" };

export interface SessionPageEnrollmentInput {
  readonly hasPageAnchor: boolean;
  readonly callerSource: string | null | undefined;
}

export function decideSessionPageEnrollment(
  input: SessionPageEnrollmentInput,
): SessionPageEnrollmentDecision {
  if (input.hasPageAnchor) return { kind: "explicit_page" };
  return { kind: "excluded", reason: "non_human_source" };
}
