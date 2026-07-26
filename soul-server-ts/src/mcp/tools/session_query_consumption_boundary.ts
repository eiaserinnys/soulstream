import type { SessionRow } from "../../db/session_db_types.js";
import type {
  ChildCompletionConsumptionRecorder,
} from "../../task/child_completion_consumption.js";
import { resolveEffectiveCallerSessionId } from "./caller_session.js";

export interface SessionQueryObservation {
  session: SessionRow;
  reflectedRevision: number | null;
}

/**
 * Single fail-closed boundary for every MCP surface that exposes session
 * results. Tool handlers only describe the revision reflected in their result;
 * relation identity and the durable write live here.
 *
 * The gate-OFF branch returns synchronously, preserving the legacy handler's
 * scheduling. Gate ON refuses to return a stale result when the child revision
 * changed between result assembly and the durable observation write.
 */
export class SessionQueryConsumptionBoundary {
  constructor(
    private readonly recorder?: Pick<
      ChildCompletionConsumptionRecorder,
      "recordObserved"
    >,
  ) {}

  get enabled(): boolean {
    return Boolean(this.recorder && resolveEffectiveCallerSessionId(undefined));
  }

  commit<T>(
    source: string,
    result: T,
    observations: SessionQueryObservation[],
  ): T | Promise<T> {
    const callerSessionId = resolveEffectiveCallerSessionId(undefined);
    if (!this.recorder || !callerSessionId) return result;
    return this.commitObserved(
      source,
      result,
      callerSessionId,
      observations,
    );
  }

  private async commitObserved<T>(
    source: string,
    result: T,
    callerSessionId: string,
    observations: SessionQueryObservation[],
  ): Promise<T> {
    const seen = new Set<string>();
    for (const observation of observations) {
      const revision = terminalRevisionReflected(observation);
      if (revision === null) continue;
      const key = `${observation.session.session_id}:${revision}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const outcome = await this.recorder!.recordObserved({
        childSessionId: observation.session.session_id,
        callerSessionId,
        terminalRevision: revision,
        source,
      });
      if (outcome === "revision_mismatch") {
        throw new Error(
          `Session ${observation.session.session_id} changed while ${source} assembled its result; retry the query`,
        );
      }
    }
    return result;
  }
}

function terminalRevisionReflected(
  observation: SessionQueryObservation,
): number | null {
  const { session, reflectedRevision } = observation;
  if (
    session.status !== "completed"
    && session.status !== "error"
    && session.status !== "interrupted"
  ) {
    return null;
  }
  if (
    reflectedRevision === null
    || session.last_event_id === null
    || reflectedRevision !== session.last_event_id
  ) {
    return null;
  }
  return reflectedRevision;
}
