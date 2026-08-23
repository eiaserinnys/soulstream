export const CONTRACT_PENDING_SESSION_ID = "contract-pending-session";
export const CONTRACT_SINCE = "2026-08-22T11:00:00.000Z";

export function pendingContractRuntime(now, directory) {
  const sessions = [{
    session_id: CONTRACT_PENDING_SESSION_ID,
    status: "running",
    created_at: new Date(now - 5_000).toISOString(),
    last_event_at: new Date(now - 1_000).toISOString(),
  }];
  const events = [{
    session_id: CONTRACT_PENDING_SESSION_ID,
    id: 1,
    event_type: "user_message",
    text: "contract: answer me",
    created_at: new Date(now - 5_000).toISOString(),
  }];
  return {
    runnerStateDirectory: directory,
    async currentManifest() {
      return { manifestId: "m", releaseCohortId: "c", sourceCommit: "s" };
    },
    async psqlOne(query) {
      if (query.includes("'ownerlessRunning'")) {
        return {
          ownerlessRunning: [], overdueRetries: [], ambiguousUncertain: [],
          reasonlessDeadLetters: [], strandedDeliveries: [], sessions: [],
          activationReceipt: { manifest_id: "m", release_cohort_id: "c", source_commit: "s" },
        };
      }
      if (query.includes("'sessions'") && query.includes("'events'")) {
        return { sessions, events };
      }
      throw new Error(`unexpected statement in contract runtime: ${query.slice(0, 60)}`);
    },
  };
}

export function boundaryAssert(condition, message) {
  if (!condition) throw new Error(message);
}
