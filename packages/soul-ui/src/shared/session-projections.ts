import type { CatalogState, SessionSummary } from "./types";

/** Apply the catalog's canonical display-name value, including an explicit clear. */
export function applyCatalogSessionDisplayName(
  session: SessionSummary,
  assignment: CatalogState["sessions"][string] | undefined,
): SessionSummary {
  if (!assignment || session.displayName === assignment.displayName) return session;
  return { ...session, displayName: assignment.displayName };
}
