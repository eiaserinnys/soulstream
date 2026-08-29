export interface S4Observation {
  entry: {
    callCount: number;
    status: string;
    prompt: string;
    runnerAttached: boolean;
    ownershipAttached: boolean;
    executionPromiseAttached: boolean;
    pidPresent: boolean;
    socketPresent: boolean;
    lockPresent: boolean;
  };
  child: {
    pid: number;
    prompt: string | null;
    executionGeneration: number | null;
  };
  receipt: {
    receiptCount: number;
    durableEventCount: number;
    deliveryCount: number;
    pumpErrors: string[];
  };
  terminal: {
    status: string;
    terminationReason: string | null;
    executionGeneration: number;
    executionIdentityCleared: boolean;
    acquireCount: number;
    releaseCount: number;
  };
  userVisible: {
    statusCode: number;
    assistantReplyCount: number;
    completionCount: number;
  };
  nextTurn: { startExecutionCallCount: number };
  cleanup: {
    taskStatus: string;
    runnerAttached: boolean;
    executionPromiseAttached: boolean;
    registrationPid: number | null;
    pidPresent: boolean;
    socketPresent: boolean;
    lockPresent: boolean;
    pidAlive: boolean;
  };
}
