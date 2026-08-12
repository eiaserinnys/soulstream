import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { renameWithTransientRetry } from "../src/atomic_file_rename.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe.skipIf(process.platform !== "win32")("Windows atomic rename contention", () => {
  it("retries a real destination handle lock until the handle is released", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atomic-rename-win32-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source.json");
    const destinationPath = join(directory, "destination.json");
    await writeFile(sourcePath, "new\n", "utf8");
    await writeFile(destinationPath, "old\n", "utf8");
    const lock = holdExclusiveWindowsHandle(destinationPath, 350);
    await lock.ready;
    let attempts = 0;
    const renameFile = vi.fn(async (source: string, destination: string) => {
      attempts += 1;
      await rename(source, destination);
    });

    await renameWithTransientRetry(sourcePath, destinationPath, {
      renameFile,
      retryDelaysMs: [50, 100, 200, 400],
    });
    await lock.closed;

    expect(attempts).toBeGreaterThan(1);
    await expect(readFile(destinationPath, "utf8")).resolves.toBe("new\n");
  }, 10_000);
});

function holdExclusiveWindowsHandle(path: string, holdMs: number): {
  ready: Promise<void>;
  closed: Promise<void>;
} {
  const script = [
    "$stream = [System.IO.File]::Open($args[0], [System.IO.FileMode]::Open,",
    "  [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
    "[Console]::Out.WriteLine('LOCKED')",
    "Start-Sleep -Milliseconds ([int]$args[1])",
    "$stream.Dispose()",
  ].join("\n");
  const child = spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
    path,
    String(holdMs),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exclusive handle helper exited ${code}: ${stderr}`));
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (chunk: string) => {
      if (chunk.includes("LOCKED")) resolve();
      else reject(new Error(`exclusive handle helper did not lock: ${chunk}`));
    });
    closed.catch(reject);
  });
  return { ready, closed };
}
