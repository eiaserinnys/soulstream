import type { AgentProfile } from "../agent_registry.js";
import { isReasoningEffort, type ReasoningEffort } from "../engine/protocol.js";

/**
 * DB-internal marker meaning "this session decided: no explicit effort, let the
 * backend default apply". Every session created by this build records either a
 * level or `auto`, which is what distinguishes it from a row that predates the
 * feature (NULL).
 *
 * It is deliberately NOT part of `ReasoningEffort`, not a wire value, not an MCP
 * input, and not selectable by any client. It is interpreted at the DB boundary
 * only; public DTOs normalise it back to "unspecified".
 */
export const REASONING_EFFORT_AUTO = "auto";

/**
 * The effort the Codex path applied before effort was ever persisted. It
 * reproduces the previous behaviour for rows that carry no decision at all:
 * sessions created before migration 089, and rows written by an older node
 * during a rolling deploy. New sessions never land here.
 */
const LEGACY_CODEX_EFFORT: ReasoningEffort = "xhigh";

/** What the stored column tells us about a session's effort decision. */
export interface StoredReasoningEffort {
  /**
   * false only for a row with no decision at all: written before migration 089,
   * or by an older node mid-deploy. Sessions this build creates always record
   * either a level or `auto`.
   */
  readonly recorded: boolean;
  /** The recorded level. Undefined for `auto` and for unrecorded rows. */
  readonly effort?: ReasoningEffort;
}

/**
 * Creation: turn the resolver's decision into the column value. Creating a
 * session is itself the decision, so the column is never NULL here — an
 * unspecified effort is recorded as `auto`, which is what later distinguishes it
 * from a row that predates the feature.
 */
export function toStoredReasoningEffort(
  resolved: ReasoningEffort | undefined,
): string {
  return resolved ?? REASONING_EFFORT_AUTO;
}

/**
 * Read-back at the DB boundary. Deliberately does NOT decide the turn's effort:
 * that needs the backend, which a `SessionRow` does not carry. Guessing the
 * backend from the model string here would be a second, lying source of truth.
 */
export function readStoredReasoningEffort(
  stored: string | null | undefined,
): StoredReasoningEffort {
  if (stored === null || stored === undefined) return { recorded: false };
  if (stored === REASONING_EFFORT_AUTO) return { recorded: true };
  // An unreadable value is treated as recorded-but-empty rather than replayed.
  return isReasoningEffort(stored)
    ? { recorded: true, effort: stored }
    : { recorded: true };
}

/**
 * The single legacy-compatibility conversion, applied where the effective
 * backend is already known. Three cases stay distinguishable:
 *
 *   no recorded decision      -> Codex replays its old `xhigh`; Claude, which
 *                                ignored effort entirely back then, gets nothing.
 *                                Covers pre-089 rows and rows written by an
 *                                older node during a rolling deploy.
 *   new session resolved auto -> nothing (the backend default applies)
 *   new session with a level  -> that level
 */
export function resolveTurnReasoningEffort(
  stored: StoredReasoningEffort,
  backend: AgentProfile["backend"] | undefined,
): ReasoningEffort | undefined {
  // An actual effort always wins. In-memory tasks and recovery paths built
  // before the `recorded` flag existed can carry a real level with no flag, and
  // replacing that with the legacy Codex value would change a live session.
  if (stored.effort !== undefined) return stored.effort;
  if (stored.recorded) return undefined;
  return backend === "codex" ? LEGACY_CODEX_EFFORT : undefined;
}

/**
 * Public projection: `auto` is internal, so every DTO leaving the server reports
 * it exactly the way an unspecified effort has always been reported.
 */
export function normalizePublicReasoningEffort(
  stored: string | null | undefined,
): string | null {
  if (stored === null || stored === undefined) return null;
  return stored === REASONING_EFFORT_AUTO ? null : stored;
}
