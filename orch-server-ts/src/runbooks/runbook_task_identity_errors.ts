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

export function isTaskIdentityTitleRace(error: unknown): boolean {
  if (error instanceof Error
    && (error.message.startsWith("task identity runbook already exists:")
      || error.message.startsWith("page is already a task identity:")
      || error.message.startsWith("task mount projection changed:")
      || error.message.startsWith("task identity project mapping changed:"))) {
    return true;
  }
  const record = asRecord(error);
  if (record.code === "PAGE_MUTATION_VERSION_CONFLICT") return true;
  return record.code === "23505"
    && (record.constraint_name === "uq_pages_title_key"
      || record.constraint === "uq_pages_title_key");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
