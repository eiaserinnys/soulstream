export class TaskIdentityTitleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskIdentityTitleConflictError";
  }
}

export function isTaskIdentityTitleConflictError(
  error: unknown,
): error is TaskIdentityTitleConflictError {
  return error instanceof TaskIdentityTitleConflictError;
}

export function isTaskIdentityCreateCollision(error: unknown): boolean {
  if (error instanceof Error
    && (error.message.startsWith("task identity task already exists:")
      || error.message.startsWith("task identity already exists:"))) return true;
  const record = asRecord(error);
  return record.code === "23505"
    && (record.constraint_name === "uq_pages_title_key"
      || record.constraint === "uq_pages_title_key");
}

export function isTaskIdentityAlreadyPromotedError(error: unknown): boolean {
  return error instanceof Error
    && error.message.startsWith("page is already a task identity:");
}

export function isTaskIdentityStalePlanConflict(error: unknown): boolean {
  if (error instanceof Error
    && (error.message.startsWith("task mount projection changed:")
      || error.message.startsWith("task mount projection changed on ")
      || error.message.startsWith("task identity project mapping changed:")
      || error.message.startsWith("task identity mapping changed:")
      || error.message.startsWith("task identity source folder changed:")
      || error.message.startsWith("task version conflict:"))) return true;
  return asRecord(error).code === "PAGE_MUTATION_VERSION_CONFLICT";
}

export function isTaskIdentityBindingConflict(error: unknown): boolean {
  return error instanceof Error
    && (error.message.startsWith("legacy task is already bound to page ")
      || error.message.startsWith("backfill page already exists:"));
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
