import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, afterEach } from "vitest";

import { readProcessStartIdentity } from "../../src/runner/runner_process_lock.js";
import { RunnerRegistrationControl } from "../../src/runner/runner_registration_control.js";
import { RunnerMutationFailure } from "../../src/runner/runner_mutation_failure.js";

/**
 * R31-A: start identity acquisition must survive a loaded host.
 *
 * The probe shells out to powershell.exe, whose bare start alone costs ~2.5s on
 * eias-linegames. When several runner paths probe at once -- spawn, dispatcher
 * and termination all do -- the round trip crosses any budget sized for the
 * idle case. A timeout is caught and returned as `null`, which callers cannot
 * distinguish from "the process is gone", so `exactProcessIsAbsent` raises
 * `live runner start identity unavailable: <pid>` against a process that is in
 * fact alive and ours. That is the live failure this contract pins.
 */
describe("R31-A windows start identity acquisition under contention", () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.pid !== undefined && child.exitCode === null) child.kill("SIGKILL");
    }
  });

  function spawnIdleChild(): ChildProcess {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    children.push(child);
    return child;
  }

  it("resolves a real start identity for a live process when probes contend", async () => {
    const child = spawnIdleChild();
    expect(child.pid).toBeTypeOf("number");
    const pid = child.pid!;

    // Six concurrent probes reproduce the contention the runner paths create.
    // Measured on this node at the pre-R31 5s budget: 2 of 6 were killed by the
    // timeout and returned null.
    const observed = await Promise.all(
      Array.from({ length: 6 }, () => readProcessStartIdentity(pid)),
    );

    const unavailable = observed.filter((identity) => identity === null);
    expect(
      unavailable.length,
      `start identity was unavailable for ${unavailable.length}/6 concurrent probes `
      + `against live pid ${pid}; a live process must always yield an identity`,
    ).toBe(0);

    // Every probe must agree: an identity that varies is not an identity.
    expect(new Set(observed)).toHaveProperty("size", 1);
    expect(observed[0]).toBeTruthy();
  }, 120_000);

  it("reports no identity for a pid that is genuinely gone", async () => {
    const child = spawnIdleChild();
    const pid = child.pid!;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
    // Absence is the one legitimate reason to answer null.
    expect(await readProcessStartIdentity(pid)).toBeNull();
  }, 60_000);
});

/**
 * R31-B: an incomplete registration identity is residue, not a live runner.
 *
 * `terminate()` refused to act whenever the registration had lost its identity
 * -- exactly the state the host's own `invalidateRunnerRegistrationIdentity`
 * leaves behind while the child keeps running. Refusing to act is what made the
 * orphan permanent: 15 disposal attempts against pid 44892 on this node all
 * failed before a single signal was sent. Disposition must be decided by what
 * the process *is*, which is the R30 substance comparison already in
 * `stopExistingRunnerLocked`.
 */
describe("R31-B termination of a registration with no identity", () => {
  interface SpawnerCall {
    method: string;
    sessionDirectory: string;
  }

  function fakeRegistration(overrides: {
    pid: number | null;
    pidStartIdentity: string | null;
  }) {
    return {
      pid: overrides.pid,
      pidStartIdentity: overrides.pidStartIdentity,
      pidAlive: true,
      registrationId: "registration-1",
      config: {
        sessionId: "session-r31",
        paths: { sessionDirectory: "/state/session-r31" },
      },
    } as never;
  }

  function fakeSpawner(calls: SpawnerCall[]) {
    return {
      terminate: async (paths: { sessionDirectory: string }) => {
        calls.push({ method: "terminate", sessionDirectory: paths.sessionDirectory });
        return "registration_invalidated" as const;
      },
      disposeUnprovenRegistration: async (paths: { sessionDirectory: string }) => {
        calls.push({
          method: "disposeUnprovenRegistration",
          sessionDirectory: paths.sessionDirectory,
        });
        return "registration_invalidated" as const;
      },
      invalidateRegistration: async () => {},
      retireTerminalRegistration: async () => {},
    } as never;
  }

  it("disposes an identity-less registration by substance instead of throwing", async () => {
    const calls: SpawnerCall[] = [];
    const control = new RunnerRegistrationControl(fakeSpawner(calls));

    const outcome = await control.terminate(
      fakeRegistration({ pid: 44892, pidStartIdentity: null }),
    );

    expect(outcome).toBe("registration_invalidated");
    expect(calls.map((call) => call.method)).toEqual(["disposeUnprovenRegistration"]);
  });

  it("disposes by substance when the registration kept no pid either", async () => {
    const calls: SpawnerCall[] = [];
    const control = new RunnerRegistrationControl(fakeSpawner(calls));

    const outcome = await control.terminate(
      fakeRegistration({ pid: null, pidStartIdentity: null }),
    );

    expect(outcome).toBe("registration_invalidated");
    expect(calls.map((call) => call.method)).toEqual(["disposeUnprovenRegistration"]);
  });

  it("still terminates by exact identity when the registration proves one", async () => {
    const calls: SpawnerCall[] = [];
    const control = new RunnerRegistrationControl(fakeSpawner(calls));

    const outcome = await control.terminate(
      fakeRegistration({ pid: 44892, pidStartIdentity: "windows-process-639236655522324327" }),
    );

    // fail-closed proof for a proven live runner is unchanged.
    expect(outcome).toBe("registration_invalidated");
    expect(calls.map((call) => call.method)).toEqual(["terminate"]);
  });

  it("surfaces a disposal failure rather than reporting a false success", async () => {
    const control = new RunnerRegistrationControl({
      terminate: async () => "registration_invalidated" as const,
      disposeUnprovenRegistration: async () => {
        throw new RunnerMutationFailure(
          "runner_registration_identity_proof_failed",
          "live runner has no exact identity and no readable command line: 44892",
        );
      },
      invalidateRegistration: async () => {},
      retireTerminalRegistration: async () => {},
    } as never);

    await expect(
      control.terminate(fakeRegistration({ pid: 44892, pidStartIdentity: null })),
    ).rejects.toThrow(/no readable command line/);
  });
});
