export class TaskIdentityTitleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskIdentityTitleConflictError";
  }
}

export class TaskIdentityRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskIdentityRequestValidationError";
  }
}

export class TaskIdentityCreateCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskIdentityCreateCollisionError";
  }
}

export class TaskIdentityAlreadyPromotedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskIdentityAlreadyPromotedError";
  }
}

export class TaskIdentityStalePlanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskIdentityStalePlanConflictError";
  }
}

export class TaskIdentityBindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskIdentityBindingConflictError";
  }
}

export function isTaskIdentityTitleConflictError(
  error: unknown,
): error is TaskIdentityTitleConflictError {
  return error instanceof TaskIdentityTitleConflictError;
}

export function isTaskIdentityRequestValidationError(
  error: unknown,
): error is TaskIdentityRequestValidationError {
  return error instanceof TaskIdentityRequestValidationError;
}

export function isTaskIdentityCreateCollision(error: unknown): boolean {
  if (error instanceof TaskIdentityCreateCollisionError) return true;
  const record = asRecord(error);
  return record.code === "23505"
    && (record.constraint_name === "uq_pages_title_key"
      || record.constraint === "uq_pages_title_key");
}

export function isTaskIdentityAlreadyPromotedError(
  error: unknown,
): error is TaskIdentityAlreadyPromotedError {
  return error instanceof TaskIdentityAlreadyPromotedError;
}

export function isTaskIdentityStalePlanConflict(error: unknown): boolean {
  return error instanceof TaskIdentityStalePlanConflictError
    || asRecord(error).code === "PAGE_MUTATION_VERSION_CONFLICT";
}

export function isTaskIdentityBindingConflict(error: unknown): boolean {
  return error instanceof TaskIdentityBindingConflictError;
}

export function taskIdentityHostErrorCode(error: unknown): string {
  if (isTaskIdentityTitleConflictError(error)) return "TASK_IDENTITY_TITLE_CONFLICT";
  if (isTaskIdentityCreateCollision(error)) return "TASK_IDENTITY_CREATE_COLLISION";
  if (isTaskIdentityAlreadyPromotedError(error)) return "TASK_IDENTITY_ALREADY_PROMOTED";
  if (isTaskIdentityStalePlanConflict(error)) return "TASK_IDENTITY_STALE_PLAN_CONFLICT";
  if (isTaskIdentityBindingConflict(error)) return "TASK_IDENTITY_BINDING_CONFLICT";
  return "TASK_IDENTITY_OPERATION_FAILED";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
