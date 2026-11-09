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
