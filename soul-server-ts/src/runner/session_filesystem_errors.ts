/** restricted 준비가 실패했을 때 full 세션에 영향을 주지 않기 위한 오류 코드. */
export const SESSION_ISOLATION_UNAVAILABLE = "SESSION_ISOLATION_UNAVAILABLE" as const;
export const ISOLATION_AUTH_UNAVAILABLE = "ISOLATION_AUTH_UNAVAILABLE" as const;
export const ISOLATION_POLICY_UNAVAILABLE = "ISOLATION_POLICY_UNAVAILABLE" as const;
export const ISOLATION_SHARED_DEPENDENCY_INODE = "ISOLATION_SHARED_DEPENDENCY_INODE" as const;

export class SessionIsolationUnavailableError extends Error {
  readonly code = SESSION_ISOLATION_UNAVAILABLE;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SessionIsolationUnavailableError";
  }
}

export class IsolationAuthUnavailableError extends Error {
  readonly code = ISOLATION_AUTH_UNAVAILABLE;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "IsolationAuthUnavailableError";
  }
}

export class IsolationPreparationPolicyError extends Error {
  readonly code = ISOLATION_POLICY_UNAVAILABLE;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "IsolationPreparationPolicyError";
  }
}

export class IsolationSharedDependencyInodeError extends Error {
  readonly code = ISOLATION_SHARED_DEPENDENCY_INODE;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "IsolationSharedDependencyInodeError";
  }
}

const ISOLATION_PREPARATION_FAILURE_CODES: ReadonlySet<string> = new Set([
  SESSION_ISOLATION_UNAVAILABLE,
  ISOLATION_AUTH_UNAVAILABLE,
  ISOLATION_POLICY_UNAVAILABLE,
  ISOLATION_SHARED_DEPENDENCY_INODE,
]);

/**
 * Identifies a turn whose restricted-runner preparation failed before any
 * execution could start.
 *
 * Such a failure is deterministic for the same input, so it must end the
 * admission with an error terminal instead of restoring the task's previous
 * terminal state. Restoring it makes the queued terminal drain resume the same
 * delivery forever. Admission races use the ordinary rollback path instead.
 *
 * Returns the original code with the original detail (prefixed once), or
 * undefined when the error is not an isolation preparation failure.
 */
export function isolationPreparationFailureDetail(
  error: unknown,
): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !ISOLATION_PREPARATION_FAILURE_CODES.has(code)) {
    return undefined;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.trim();
  if (!message) return code;
  return message.startsWith(`${code}:`) ? message : `${code}: ${message}`;
}
