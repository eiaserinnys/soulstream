import { validatePageBlockProperties } from "@soulstream/page-model";

import type { PageMutationActor } from "./page_mutation_core.js";

export class PageMutationValidationError extends Error {
  readonly code = "PAGE_MUTATION_INVALID";
}

export function validateBlockProperties(
  type: string,
  value: Record<string, unknown>,
): void {
  validateBoundary(type, "block type");
  const error = validatePageBlockProperties(type, value);
  if (error) throw new PageMutationValidationError(error);
}

export function validateActor(actor: PageMutationActor): void {
  if (actor.actorKind === "agent") {
    validateBoundary(actor.actorSessionId ?? "", "agent actor session id");
  }
  if (actor.actorKind === "user") {
    validateBoundary(actor.actorUserId ?? "", "user actor user id");
  }
}

export function validateIdempotencyKey(value: string): void {
  validateBoundary(value, "idempotency key");
  const parts = value.split(":");
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !part.trim())) {
    throw new PageMutationValidationError(
      "idempotency key must use tool:caller:request format",
    );
  }
}

export function validateTitle(value: string): void {
  validateBoundary(value.trim(), "page title");
}

export function validateBoundary(value: string, label: string): void {
  if (!value || value.trim() !== value) {
    throw new PageMutationValidationError(`${label} must be a non-empty trimmed string`);
  }
}
