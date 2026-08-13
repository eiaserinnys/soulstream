import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Temp directories created through here are removed when the test file that
 * created them finishes.
 *
 * Tests that call `mkdtemp` directly and never remove the result leak a
 * directory per run. On this workspace that had grown into the thousands, and
 * one soak fixture alone accounted for over a hundred. The registry is
 * module-scoped and vitest gives each test file its own module graph, so the
 * `afterAll` installed by `tests/setup/temp_dir_cleanup.ts` sweeps exactly the
 * directories that file created — including ones made in `beforeAll`, which a
 * per-test hook could not reach.
 */
const created: string[] = [];

export async function makeTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}

export function makeTempDirSync(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}

export async function removeTrackedTempDirs(): Promise<void> {
  await Promise.all(
    created.splice(0).map(
      async (directory) => await rm(directory, { recursive: true, force: true }),
    ),
  );
}
