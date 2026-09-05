import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunnerSqliteEventOutbox } from "../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../src/runner/sqlite_runner_lifecycle.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("RunnerSqliteLifecycle observation mismatch", () => {
  it("uses explicit mismatch errors for stale progress and tool observations", async () => {
    const fixture = await createFixture();
    fixture.lifecycle.begin({
      pid: 5001,
      commandId: "execute-current",
      progressedAt: "2026-09-05T08:00:00.000Z",
    });
    const current = fixture.lifecycle.read();

    const progressMismatch = captureError(() => fixture.lifecycle.progress(
      "execute-stale",
      "2026-09-05T08:00:01.000Z",
    ));
    expect((progressMismatch as Error).constructor.name).toBe(
      "RunnerLifecycleCommandMismatchError",
    );
    expect(fixture.lifecycle.read()).toEqual(current);
    const toolMismatch = captureError(() => fixture.lifecycle.toolStarted(
      "execute-stale",
      "tool-stale",
      "2026-09-05T08:00:02.000Z",
    ));
    expect((toolMismatch as Error).constructor.name).toBe(
      "RunnerLifecycleCommandMismatchError",
    );
    expect(fixture.lifecycle.read()).toEqual(current);

    fixture.lifecycle.close();
    fixture.outbox.close();
  });

  it("keeps terminal command mismatch outside observation errors", async () => {
    const fixture = await createFixture();
    fixture.lifecycle.begin({
      pid: 5001,
      commandId: "execute-current",
      progressedAt: "2026-09-05T08:00:00.000Z",
    });
    const current = fixture.lifecycle.read();

    const mismatch = await fixture.outbox.finishExecution({
      commandId: "execute-stale",
      state: "completed",
      progressedAt: "2026-09-05T08:00:01.000Z",
      terminalError: null,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(mismatch).toBeInstanceOf(Error);
    expect((mismatch as Error).constructor.name).not.toBe(
      "RunnerLifecycleCommandMismatchError",
    );
    expect((mismatch as Error).message).toContain("runner lifecycle command mismatch");
    expect(fixture.lifecycle.read()).toEqual(current);

    fixture.lifecycle.close();
    fixture.outbox.close();
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "runner-lifecycle-observation-"));
  directories.push(directory);
  const databasePath = join(directory, "runner.sqlite");
  const outbox = await RunnerSqliteEventOutbox.create(databasePath);
  const lifecycle = RunnerSqliteLifecycle.open(databasePath, "session-a");
  return { outbox, lifecycle };
}

function captureError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to throw");
}
