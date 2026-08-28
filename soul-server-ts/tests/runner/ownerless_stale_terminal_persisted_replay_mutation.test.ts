import { describe, expect, it } from "vitest";

import {
  applyPersistedReplayFilterRemovedMutation,
  idealStaleTerminalPersistedReplayExtension,
  PERSISTED_REPLAY_FILTER_REMOVED_VIOLATION,
  staleTerminalPersistedReplayViolations,
} from "./ownerless_stale_terminal_persisted_replay_oracle.js";

describe("ownerless stale terminal persisted replay mutation oracle", () => {
  it("names semantic replay isolation removal as a contract violation", () => {
    const baseline = idealStaleTerminalPersistedReplayExtension();
    expect(staleTerminalPersistedReplayViolations(baseline)).toEqual([]);
    const mutated = applyPersistedReplayFilterRemovedMutation(baseline);
    const violations = staleTerminalPersistedReplayViolations(mutated);
    expect(violations).toContain(PERSISTED_REPLAY_FILTER_REMOVED_VIOLATION);
    console.info(
      "[ownerless persisted replay filter removal mutation]",
      JSON.stringify({ violation: PERSISTED_REPLAY_FILTER_REMOVED_VIOLATION, violations }),
    );
  });
});
