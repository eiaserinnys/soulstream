import type { InMemoryNodeRegistry } from "../node/registry.js";
import type {
  SessionReviewAcknowledgeOutcome,
  SessionReviewAcknowledgeRepository,
} from "../session/session_review_acknowledge_fallback.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";
import { serializeSessionRow } from "./live_session_serialization.js";

export type CreateLiveSessionReviewRepositoryOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
  readonly registry?: InMemoryNodeRegistry;
};

export function createLiveSessionReviewRepository(
  options: CreateLiveSessionReviewRepositoryOptions,
): SessionReviewAcknowledgeRepository {
  return {
    async acknowledgeSessionReview(sessionId) {
      const sql = await options.sqlResolver.resolveSql();
      const outcomeRows = await sql`
        SELECT session_acknowledge_review(${sessionId}, ${new Date()}) AS outcome
      `;
      const outcome = parseOutcome(outcomeRows[0]?.outcome);
      if (outcome !== "acknowledged" && outcome !== "already_acknowledged") {
        return { outcome, session: null };
      }

      const sessionRows = await sql`
        SELECT * FROM session_get(${sessionId}) LIMIT 1
      `;
      const sessionRow = sessionRows[0];
      return {
        outcome,
        session: sessionRow === undefined
          ? null
          : serializeSessionRow(sessionRow, { registry: options.registry }),
      };
    },
  };
}

function parseOutcome(value: unknown): SessionReviewAcknowledgeOutcome {
  if (
    value === "acknowledged" ||
    value === "already_acknowledged" ||
    value === "not_found" ||
    value === "not_required" ||
    value === "not_pending"
  ) {
    return value;
  }
  throw new Error(`Unexpected session_acknowledge_review outcome: ${String(value)}`);
}
