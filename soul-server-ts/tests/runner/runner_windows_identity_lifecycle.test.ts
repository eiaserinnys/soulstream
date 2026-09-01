import { describe, expect, it } from "vitest";

import { RunnerRegistrationControl } from "../../src/runner/runner_registration_control.js";
import { RunnerMutationFailure } from "../../src/runner/runner_mutation_failure.js";

/**
 * R31-B: an incomplete registration identity is residue, not a live runner.
 *
 * `terminate()` refused to act whenever the registration had lost its identity
 * -- exactly the state the host's own `invalidateRunnerRegistrationIdentity`
 * leaves behind while the child keeps running. Refusing to act is what made the
 * orphan permanent: 15 disposal attempts against pid 44892 on this node all
 * failed before a single signal was sent. Disposition is now decided by the
 * session's kernel writer lock even when registration fields are incomplete.
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
          "runner writer lock ownership unavailable: 44892",
        );
      },
      invalidateRegistration: async () => {},
      retireTerminalRegistration: async () => {},
    } as never);

    await expect(
      control.terminate(fakeRegistration({ pid: 44892, pidStartIdentity: null })),
    ).rejects.toThrow(/writer lock ownership unavailable/);
  });
});
