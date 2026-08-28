import { createServer, type Server } from "node:net";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import {
  pendingRunnerRegistrationIdentity,
  readRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import { retireTerminalRunnerRegistrationFiles } from
  "../../src/runner/runner_registration_mutation.js";

const cleanupFault = vi.hoisted(() => ({ attempt: 0, failAt: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      if (/runner\.(?:pid|sock)\.mutation-/.test(String(path))) {
        cleanupFault.attempt += 1;
        if (cleanupFault.attempt === cleanupFault.failAt) {
          throw Object.assign(new Error(`quarantine cleanup ${cleanupFault.attempt} denied`), {
            code: "EACCES",
          });
        }
      }
      await actual.unlink(path);
    },
  };
});

const directories: string[] = [];
const ORIGINAL_PID = 73_201;
const ORIGINAL_START_IDENTITY = "node-start-638920800004560000";
const RETIRED_AT = new Date("2026-08-28T01:00:00.000Z");

afterEach(async () => {
  cleanupFault.attempt = 0;
  cleanupFault.failAt = 0;
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe.skipIf(process.platform === "win32")(
  "runner retirement committed quarantine cleanup",
  () => {
    it.each([1, 2])(
      "keeps the committed mutation successful when quarantine removal %s fails",
      async (failAt) => {
        cleanupFault.attempt = 0;
        cleanupFault.failAt = failAt;
        const stateDirectory = await temporaryStateDirectory();
        const paths = runnerProcessPaths(stateDirectory, `commit-cleanup-${failAt}`);
        await mkdir(paths.sessionDirectory, { recursive: true });
        const identity = {
          ...pendingRunnerRegistrationIdentity(`commit-cleanup-${failAt}`, "release-a"),
          pid: ORIGINAL_PID,
          startIdentity: ORIGINAL_START_IDENTITY,
        };
        await writeRunnerRegistrationIdentity(paths.sessionDirectory, identity);
        await writeFile(paths.pidPath, `${ORIGINAL_PID}\n`, { mode: 0o600 });
        const server = await listenOnUnixSocket(paths.socketPath);

        try {
          await expect(retireTerminalRunnerRegistrationFiles(
            paths,
            identity.registrationId,
            RETIRED_AT,
          )).resolves.toBeUndefined();

          expect(cleanupFault.attempt).toBe(2);
          await expect(readRunnerRegistrationIdentity(paths.sessionDirectory)).resolves
            .toMatchObject({
              registrationId: identity.registrationId,
              pid: null,
              startIdentity: null,
              retiredAt: RETIRED_AT.toISOString(),
            });
          await expect(readFile(paths.pidPath, "utf8"))
            .rejects.toMatchObject({ code: "ENOENT" });
          await expect(lstat(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          await closeServer(server);
        }
      },
    );
  },
);

async function temporaryStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runner-retirement-commit-cleanup-"));
  directories.push(directory);
  return directory;
}

async function listenOnUnixSocket(path: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
