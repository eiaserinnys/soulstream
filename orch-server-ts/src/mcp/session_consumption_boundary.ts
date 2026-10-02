import { buildDeterministicDeliveryIdentity } from "@soulstream/wire-schema/delivery";
import type { SessionDeliveryRepository } from "../control_plane/repositories/session_delivery_repository.js";
import type { McpCallContext } from "./types.js";
import type { McpSessionRow } from "./session_read_adapter.js";

export interface SessionQueryObservation {
  session: McpSessionRow;
  reflectedRevision: number | null;
}

/** Same terminal-child gate as the worker boundary; the write completes before returning. */
export class SessionConsumptionBoundary {
  private readonly callerSessionId: string | null;
  constructor(private readonly repository: SessionDeliveryRepository, context: McpCallContext) {
    this.callerSessionId = context.principal === "external" ? null : context.callerSessionId?.trim() || null;
  }
  get enabled(): boolean { return Boolean(this.callerSessionId); }
  async commit<T>(source: string, result: T, observations: SessionQueryObservation[]): Promise<T> {
    const callerSessionId = this.callerSessionId;
    if (!callerSessionId) return result;
    const seen = new Set<string>();
    const batch = [];
    for (const { session, reflectedRevision } of observations) {
      if (session.caller_session_id !== callerSessionId) continue;
      if (!["completed", "error", "interrupted"].includes(session.status)) continue;
      if (reflectedRevision === null || session.last_event_id === null || reflectedRevision !== session.last_event_id) continue;
      const key = `${session.session_id}:${reflectedRevision}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const relationKey = `child_session:${session.session_id}:${reflectedRevision}`;
      const identity = buildDeterministicDeliveryIdentity({ targetSessionId: callerSessionId, relationKey, intent: "completion_notification" });
      batch.push({ childSessionId: session.session_id, observedRevision: reflectedRevision, relationKey,
        completionId: identity.completionId, callerSessionId, consumedTurnId: `mcp:${source}:${session.session_id}:${reflectedRevision}` });
    }
    if (batch.length === 0) return result;
    let outcome;
    try { outcome = await this.repository.recordObservedChildCompletions(batch); }
    catch (error) {
      throw new Error(`session-deliveries host record_observed_child_completions failed: ${error instanceof Error ? error.message : "Persistence host operation failed"}`);
    }
    if (outcome.status !== "recorded") throw new Error(
      `Session ${outcome.childSessionId} changed while ${source} assembled its result (${outcome.status}); retry the query`,
    );
    return result;
  }
}
