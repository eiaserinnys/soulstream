import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import {
  pendingRunnerRegistrationIdentity,
  readRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import { invalidateRunnerRegistrationFiles } from
  "../../src/runner/runner_registration_mutation.js";

/**
 * Reproduces Windows named-pipe semantics on any platform: `lstat` on a pipe
 * path succeeds while the pipe is held open by its owning process, but
 * `rename` always fails with ENOENT because the pipe namespace has no
 * filesystem entry to move. This is the exact failure observed live as
 * `runner_registration_persistence_failed: registration files were not
 * committed` on eias-linegames (R9/R10).
 */
const PIPE_PREFIX = "\\\\.\\pipe\\";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      if (String(path).startsWith(PIPE_PREFIX)) {
        return { isDirectory: () => false } as Awaited<ReturnType<typeof actual.lstat>>;
      }
      return actual.lstat(path);
    },
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1],
    ) => {
      if (String(from).startsWith(PIPE_PREFIX) || String(to).startsWith(PIPE_PREFIX)) {
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, rename '${String(from)}' -> '${String(to)}'`),
          { code: "ENOENT" },
        );
      }
      return actual.rename(from, to);
    },
  };
});

const directories: string[] = [];
const LIVE_PID = 51_436;
const LIVE_START_IDENTITY = "node-start-1788063773772";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner registration evidence with a named-pipe transport", () => {
  it("invalidates the registration without touching the pipe held by an orphaned runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-pipe-evidence-"));
    directories.push(root);
    const stateDirectory = join(root, "runner-state");
    const paths = runnerProcessPaths(stateDirectory, "pipe-session", "win32");
    expect(paths.socketKind).toBe("named_pipe");
    expect(paths.socketPath.startsWith(PIPE_PREFIX)).toBe(true);

    await mkdir(paths.sessionDirectory, { recursive: true });
    const identity = {
      ...pendingRunnerRegistrationIdentity("pipe-session", "release-pipe"),
      pid: LIVE_PID,
      startIdentity: LIVE_START_IDENTITY,
    };
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, identity);
    await writeFile(paths.pidPath, `${LIVE_PID}\n`, { mode: 0o600 });

    // Pre-fix behavior: snapshotEvidence lstats the pipe (succeeds), tries to
    // quarantine it via rename (ENOENT) and the whole invalidation dies with
    // runner_registration_persistence_failed. The fix excludes the pipe from
    // the filesystem evidence set entirely, so this must now resolve.
    await expect(invalidateRunnerRegistrationFiles(
      paths,
      identity.registrationId,
    )).resolves.toBeUndefined();

    await expect(readRunnerRegistrationIdentity(paths.sessionDirectory)).resolves
      .toMatchObject({
        registrationId: identity.registrationId,
        pid: null,
        startIdentity: null,
      });
  });

  it("still quarantines a unix socket file transport as filesystem evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-unix-evidence-"));
    directories.push(root);
    const stateDirectory = join(root, "runner-state");
    const paths = runnerProcessPaths(stateDirectory, "unix-session", "linux");
    expect(paths.socketKind).toBe("unix_socket");

    await mkdir(paths.sessionDirectory, { recursive: true });
    const identity = {
      ...pendingRunnerRegistrationIdentity("unix-session", "release-unix"),
      pid: LIVE_PID,
      startIdentity: LIVE_START_IDENTITY,
    };
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, identity);
    await writeFile(paths.pidPath, `${LIVE_PID}\n`, { mode: 0o600 });
    await writeFile(paths.socketPath, "", { mode: 0o600 });

    await expect(invalidateRunnerRegistrationFiles(
      paths,
      identity.registrationId,
    )).resolves.toBeUndefined();

    await expect(readRunnerRegistrationIdentity(paths.sessionDirectory)).resolves
      .toMatchObject({ pid: null, startIdentity: null });
  });

  it("derives the transport kind from the platform in the paths factory", () => {
    const windows = runnerProcessPaths("/state", "factory-session", "win32");
    expect(windows.socketKind).toBe("named_pipe");
    const linux = runnerProcessPaths("/state", "factory-session", "linux");
    expect(linux.socketKind).toBe("unix_socket");
    expect(linux.socketPath).toBe(join(linux.sessionDirectory, "runner.sock"));
  });
});
