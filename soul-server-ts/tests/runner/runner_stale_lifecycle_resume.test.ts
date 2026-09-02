import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RunnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import {
  stopExistingRunnerLocked,
  type RunnerProcessTerminationDependencies,
} from "../../src/runner/runner_process_termination.js";
import {
  readRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
  type RunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import type { RunnerWriterLockState } from "../../src/runner/runner_writer_lock.js";

const STALE_LIFECYCLE_PID = 15_228;
const LIVE_LOCK_OWNER = {
  pid: STALE_LIFECYCLE_PID,
  startIdentity: "runner-lock-owner-r30",
};

describe("stopExistingRunnerLocked with stale lifecycle evidence", () => {
  it("isolates an identity-less lifecycle pid when the runner lock is free", async () => {
    const { paths } = await sessionFixture({ pid: null, startIdentity: null });
    const signalPid = vi.fn();

    const outcome = await stopExistingRunnerLocked(paths, dependencies({
      signalPid,
      inspectWriterLock: sequence({ kind: "free" }),
    }));

    expect(outcome).toBe("registration_invalidated");
    expect(signalPid).not.toHaveBeenCalled();
    await expect(readRunnerRegistrationIdentity(paths.sessionDirectory))
      .resolves.toMatchObject({ pid: null, startIdentity: null });
  });

  it("still fails closed when an exact registration has an unavailable lock owner", async () => {
    const { paths } = await sessionFixture({
      pid: STALE_LIFECYCLE_PID,
      startIdentity: "windows-process-639238230526475757",
    });
    await writeFile(paths.pidPath, `${STALE_LIFECYCLE_PID}\n`, "utf8");

    await expect(stopExistingRunnerLocked(paths, dependencies({
      inspectWriterLock: sequence({ kind: "unavailable" }),
    }))).rejects.toMatchObject({ code: "runner_registration_identity_proof_failed" });
  });

  it("uses an exact pre-close proof while the same runner releases its writer lock", async () => {
    const startIdentity = "runner-lock-owner-closing";
    const { paths } = await sessionFixture({
      pid: STALE_LIFECYCLE_PID,
      startIdentity,
    });
    const signalPid = vi.fn();

    const outcome = await stopExistingRunnerLocked(paths, dependencies({
      signalPid,
      inspectProcess: async () => ({ alive: true, startIdentity }),
      inspectWriterLock: sequence(
        { kind: "unavailable" },
        { kind: "free" },
      ),
    }), {
      registrationId: "3cc2bea2-19bc-4b94-b296-c399a89892ed",
      pid: STALE_LIFECYCLE_PID,
      startIdentity,
    });

    expect(outcome).toBe("registration_invalidated");
    expect(signalPid).toHaveBeenCalledOnce();
    expect(signalPid).toHaveBeenCalledWith(STALE_LIFECYCLE_PID, "SIGTERM");
  });

  it("terminates the session runner proven by the held lock even after identity loss", async () => {
    const { paths } = await sessionFixture({ pid: null, startIdentity: null });
    const signalPid = vi.fn();

    const outcome = await stopExistingRunnerLocked(paths, dependencies({
      signalPid,
      inspectWriterLock: sequence(
        { kind: "held", owner: LIVE_LOCK_OWNER },
        { kind: "free" },
      ),
    }));

    expect(signalPid).toHaveBeenCalledWith(STALE_LIFECYCLE_PID, "SIGTERM");
    expect(outcome).toBe("registration_invalidated");
  });

  it("never signals an unrelated process occupying a recycled lifecycle pid", async () => {
    const { paths } = await sessionFixture({ pid: null, startIdentity: null });
    const signalPid = vi.fn();

    const outcome = await stopExistingRunnerLocked(paths, dependencies({
      signalPid,
      inspectWriterLock: sequence({ kind: "free" }),
    }));

    expect(signalPid).not.toHaveBeenCalled();
    expect(outcome).toBe("registration_invalidated");
  });

  it("terminates the owner held by this session lock despite stale pid residue", async () => {
    const { paths } = await sessionFixture({ pid: null, startIdentity: null });
    const signalPid = vi.fn();

    await expect(stopExistingRunnerLocked(paths, dependencies({
      signalPid,
      inspectWriterLock: sequence(
        {
          kind: "held",
          owner: { pid: 91_337, startIdentity: "replacement-owner" },
        },
        { kind: "free" },
      ),
    }))).resolves.toBe("registration_invalidated");

    expect(signalPid).toHaveBeenCalledWith(91_337, "SIGTERM");
  });

  it("fails closed when a held lock has no readable owner record", async () => {
    const { paths } = await sessionFixture({ pid: null, startIdentity: null });
    const signalPid = vi.fn();

    await expect(stopExistingRunnerLocked(paths, dependencies({
      signalPid,
      inspectWriterLock: sequence({ kind: "unavailable" }),
    }))).rejects.toMatchObject({ code: "runner_registration_identity_proof_failed" });
    expect(signalPid).not.toHaveBeenCalled();
  });
});

async function sessionFixture(
  identityOwner: Pick<RunnerRegistrationIdentity, "pid" | "startIdentity">,
): Promise<{ paths: RunnerProcessPaths }> {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "r30-runner-"));
  const paths: RunnerProcessPaths = {
    sessionDirectory,
    databasePath: join(sessionDirectory, "runner.sqlite"),
    socketPath: "\\\\.\\pipe\\soulstream-runner-843db1ba8c5e6e6a9d59eb54",
    socketKind: "named_pipe",
    pidPath: join(sessionDirectory, "runner.pid"),
    lockPath: join(sessionDirectory, "runner.lock"),
    configPath: join(sessionDirectory, "runner-config.json"),
    logPath: join(sessionDirectory, "runner.log"),
  };
  await writeRunnerRegistrationIdentity(sessionDirectory, {
    schemaVersion: 1,
    registrationId: "3cc2bea2-19bc-4b94-b296-c399a89892ed",
    sessionId: "11d703c3-deb6-448c-95e9-fa88b2d1ef74",
    codeSha: "sha256-66fb3d5e6b209430ce851a0f6c492406ab2b5b25f32414f10984cb9ce40bb879",
    ...identityOwner,
  });
  expect(JSON.parse(
    await readFile(join(sessionDirectory, "runner-identity.json"), "utf8"),
  )).toMatchObject(identityOwner);
  return { paths };
}

function dependencies(
  overrides: Partial<RunnerProcessTerminationDependencies>,
): RunnerProcessTerminationDependencies {
  return {
    inspectWriterLock: sequence({ kind: "free" }),
    inspectProcess: async () => ({ alive: false, startIdentity: null }),
    signalPid: vi.fn(),
    now: () => 0,
    delay: async () => {},
    ...overrides,
  };
}

function sequence(...states: RunnerWriterLockState[]) {
  let index = 0;
  return vi.fn(async () => states[Math.min(index++, states.length - 1)]!);
}
