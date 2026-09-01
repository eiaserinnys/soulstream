import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ProcessCommandLineProbe } from "../../src/runner/runner_process_lock.js";
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
import type { RunnerLifecycleRecord } from "../../src/runner/sqlite_runner_lifecycle.js";

/**
 * R30 — Windows resume death.
 *
 * Live shape observed on eias-linegames (session 11d703c3, runner-state
 * 843db1ba8c5e6e6a9d59eb54, 260901):
 *
 *   runner-identity.json : { pid: null, startIdentity: null }   <- registration retired
 *   runner.pid           : absent                                <- evidence removed
 *   lifecycle (SQLite)   : { runner_pid: 15228, execution_state: "completed" }
 *
 * The child had already lost host execution ownership ("Execution ownership
 * unavailable for renewal" -> "runner lifecycle command mismatch" -> socket
 * disconnected) while the process itself survived, so the host nulled the
 * registration identity but nothing ever cleared the lifecycle pid.
 *
 * On Windows `isPidAlive` (process.kill(pid, 0), EPERM => alive) reports that
 * pid as live either through pid recycling or ACCESS_DENIED. Measured on this
 * node: 8 pids report alive while absent from the OS process table, and pid
 * occupancy is 2.76%.
 *
 * Contract under test: a lifecycle pid that no registration identity vouches
 * for is residue, and its disposition is decided by the process itself -- its
 * command line -- never by the number. Proven ours, terminate; absent or a
 * stranger, isolate and never signal; unknown, keep failing closed.
 */

const STALE_LIFECYCLE_PID = 15_228;
const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const SNAPSHOT_DIR = "D:\\haniel-root\\services\\soulstream\\.local\\runner-releases\\a1b2c3";

describe("stopExistingRunnerLocked with stale lifecycle evidence", () => {
  it("isolates an identity-less lifecycle pid instead of blocking resume", async () => {
    const { paths } = await sessionFixture({ pid: null, startIdentity: null });
    const isPidAlive = vi.fn(() => true);
    const signalPid = vi.fn();

    const outcome = await stopExistingRunnerLocked(paths, dependencies({
      isPidAlive,
      signalPid,
      // The live shape: alive by number, absent from the process table.
      readCommandLine: async () => ({ kind: "absent" }),
      readLifecycle: async () => staleLifecycle(),
    }));

    expect(outcome).toBe("registration_invalidated");
    // The identity-less pid is never signalled: nothing proves it is our runner.
    expect(signalPid).not.toHaveBeenCalled();
    const identity = await readRunnerRegistrationIdentity(paths.sessionDirectory);
    expect(identity).toMatchObject({ pid: null, startIdentity: null });
  });

  it("still fails closed when a proven registration owns a live unprovable pid", async () => {
    const { paths } = await sessionFixture({
      pid: STALE_LIFECYCLE_PID,
      startIdentity: "windows-process-639238230526475757",
    });
    await writeFile(paths.pidPath, `${STALE_LIFECYCLE_PID}\n`, "utf8");

    await expect(stopExistingRunnerLocked(paths, dependencies({
      isPidAlive: () => true,
      inspectProcess: async () => ({ alive: true, startIdentity: null }),
      readLifecycle: async () => staleLifecycle(),
    }))).rejects.toMatchObject({
      code: "runner_registration_identity_proof_failed",
    });
  });

  it("isolates an identity-less lifecycle pid that is already dead", async () => {
    const { paths } = await sessionFixture({ pid: null, startIdentity: null });

    const outcome = await stopExistingRunnerLocked(paths, dependencies({
      isPidAlive: () => false,
      readLifecycle: async () => staleLifecycle(),
    }));

    expect(outcome).toBe("registration_invalidated");
  });

  it("terminates a live orphan whose command line proves it is this session's runner", async () => {
    const { paths } = await sessionFixture({ pid: null, startIdentity: null });
    let alive = true;
    const signalPid = vi.fn(() => {
      alive = false;
    });

    const outcome = await stopExistingRunnerLocked(paths, dependencies({
      isPidAlive: () => alive,
      signalPid,
      readCommandLine: async () => ownRunnerCommandLine(paths),
      readLifecycle: async () => staleLifecycle(),
    }));

    // Our own orphan is disposed of, so no writer lock or named pipe of ours
    // survives to contend with the replacement runner.
    expect(signalPid).toHaveBeenCalledWith(STALE_LIFECYCLE_PID, "SIGTERM");
    expect(outcome).toBe("registration_invalidated");
  });

  it("never signals a recycled pid that belongs to an unrelated process", async () => {
    const { paths } = await sessionFixture({ pid: null, startIdentity: null });
    const signalPid = vi.fn();

    const outcome = await stopExistingRunnerLocked(paths, dependencies({
      isPidAlive: () => true,
      signalPid,
      readCommandLine: async () => ({
        kind: "command_line",
        value: "C:\\Windows\\System32\\svchost.exe -k NetworkService -p",
      }),
      readLifecycle: async () => staleLifecycle(),
    }));

    expect(signalPid).not.toHaveBeenCalled();
    expect(outcome).toBe("registration_invalidated");
  });

  it("never signals another session's runner that inherited the pid", async () => {
    const { paths } = await sessionFixture({ pid: null, startIdentity: null });
    const signalPid = vi.fn();
    const siblingConfigPath = join(
      paths.sessionDirectory,
      "..",
      "0f9e8d7c6b5a4938271605f4",
      "runner-config.json",
    );

    const outcome = await stopExistingRunnerLocked(paths, dependencies({
      isPidAlive: () => true,
      signalPid,
      // A Soulstream runner, but not ours: the entry module alone is not proof.
      readCommandLine: async () => ({
        kind: "command_line",
        value: `"${NODE_EXE}" "${SNAPSHOT_DIR}\\runner_entry.js" --config "${siblingConfigPath}"`,
      }),
      readLifecycle: async () => staleLifecycle(),
    }));

    expect(signalPid).not.toHaveBeenCalled();
    expect(outcome).toBe("registration_invalidated");
  });

  it("fails closed when the command line of a live pid cannot be read", async () => {
    const { paths } = await sessionFixture({ pid: null, startIdentity: null });
    const signalPid = vi.fn();

    await expect(stopExistingRunnerLocked(paths, dependencies({
      isPidAlive: () => true,
      signalPid,
      // Protected process, denied access, unsupported platform: unknown is not
      // a verdict. Neither kill nor proceed.
      readCommandLine: async () => ({ kind: "unavailable" }),
      readLifecycle: async () => staleLifecycle(),
    }))).rejects.toMatchObject({
      code: "runner_registration_identity_proof_failed",
    });
    expect(signalPid).not.toHaveBeenCalled();
  });
});

function ownRunnerCommandLine(paths: RunnerProcessPaths): ProcessCommandLineProbe {
  // Quoted exactly as the OS reports it, not as `join` produced it.
  return {
    kind: "command_line",
    value: `"${NODE_EXE}" "${SNAPSHOT_DIR}\\runner_entry.js" --config "${paths.configPath}"`,
  };
}

function staleLifecycle(): RunnerLifecycleRecord {
  return {
    session_id: "11d703c3-deb6-448c-95e9-fa88b2d1ef74",
    runner_pid: STALE_LIFECYCLE_PID,
    execution_command_id: "execute:24b02b1a-c3bd-4bd2-aa8e-2e34a0b4ed56",
    execution_state: "completed",
    progress_seq: 344,
    progress_at: "2026-09-01T00:56:14.535Z",
    liveness_at: "2026-09-01T00:56:14.535Z",
    in_flight_tools: [],
    terminal_error: null,
  } as unknown as RunnerLifecycleRecord;
}

async function sessionFixture(
  identityOwner: Pick<RunnerRegistrationIdentity, "pid" | "startIdentity">,
): Promise<{ paths: RunnerProcessPaths }> {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "r30-runner-"));
  const paths: RunnerProcessPaths = {
    sessionDirectory,
    databasePath: join(sessionDirectory, "runner.sqlite"),
    // Windows shape: the transport is a named pipe, not a filesystem entry.
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
  // Guard the fixture itself: the identity must be readable as written.
  expect(JSON.parse(
    await readFile(join(sessionDirectory, "runner-identity.json"), "utf8"),
  )).toMatchObject(identityOwner);
  return { paths };
}

function dependencies(
  overrides: Partial<RunnerProcessTerminationDependencies>,
): RunnerProcessTerminationDependencies {
  return {
    inspectProcess: async () => ({ alive: false, startIdentity: null }),
    isPidAlive: () => false,
    signalPid: vi.fn(),
    now: () => 0,
    delay: async () => {},
    readLifecycle: async () => null,
    readCommandLine: async () => ({ kind: "absent" }),
    ...overrides,
  };
}
