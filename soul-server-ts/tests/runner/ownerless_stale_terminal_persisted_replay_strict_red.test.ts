import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
} from "../db/full_schema_postgres_harness.js";
import { OwnerlessStaleTerminalFanoutHarness } from
  "./ownerless_stale_terminal_fanout_harness.js";
import { OwnerlessStaleTerminalPersistedReplayHarness } from
  "./ownerless_stale_terminal_persisted_replay_harness.js";
import {
  appliedTerminalPersistedReplayViolations,
  idealStaleTerminalPersistedReplayExtension,
  staleTerminalPersistedReplayViolations,
} from "./ownerless_stale_terminal_persisted_replay_oracle.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("ownerless stale terminal persisted replay strict RED", () => {
  let postgres: FullSchemaPostgresHarness;
  let persisted: OwnerlessStaleTerminalPersistedReplayHarness;
  let live: OwnerlessStaleTerminalFanoutHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
    persisted = new OwnerlessStaleTerminalPersistedReplayHarness(postgres);
    live = new OwnerlessStaleTerminalFanoutHarness(postgres);
  }, 60_000);

  afterAll(async () => {
    await postgres?.cleanup();
  });

  it("has one zero-violation persisted replay ideal", () => {
    expect(staleTerminalPersistedReplayViolations(
      idealStaleTerminalPersistedReplayExtension(),
    )).toEqual([]);
  });

  it("keeps a rejected stale terminal as raw audit only across persisted SSE replay", async () => {
    const observation = {
      persisted: await persisted.observeRejectedStaleTerminal(),
      live: await live.observeRejectedStaleTerminal(),
    };
    const violations = staleTerminalPersistedReplayViolations(observation);
    console.info(
      "[ownerless stale terminal persisted replay strict RED]",
      JSON.stringify({ observation, violations }),
    );
    expect(violations).toEqual([]);
  });

  it("replays one persisted semantic completion for an applied terminal", async () => {
    const observation = {
      persisted: await persisted.observeAppliedTerminal(),
      live: await live.observeAppliedTerminal(),
    };
    const violations = appliedTerminalPersistedReplayViolations(observation);
    console.info(
      "[ownerless applied terminal persisted replay control]",
      JSON.stringify({ observation, violations }),
    );
    expect(violations).toEqual([]);
  });
});
