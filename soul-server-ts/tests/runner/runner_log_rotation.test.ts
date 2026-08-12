import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { rotateRunnerLogIfNeeded } from "../../src/runner/runner_log_rotation.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner log rotation", () => {
  it("caps the active log and retains bounded newest backups", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-log-"));
    directories.push(directory);
    const path = join(directory, "runner.log");
    writeFileSync(path, "abcdefgh");
    writeFileSync(`${path}.1`, "previous");
    const fd = openSync(path, "a");
    try {
      expect(rotateRunnerLogIfNeeded(fd, path, 5, 2)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("");
      expect(readFileSync(`${path}.1`, "utf8")).toBe("defgh");
      expect(readFileSync(`${path}.2`, "utf8")).toBe("previous");
    } finally {
      closeSync(fd);
    }
  });
});
