import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { readProcessCommandLine } from "../../src/runner/runner_process_lock.js";
import {
  commandLineOwnedBySession,
  type RunnerProcessPaths,
} from "../../src/runner/runner_process_paths.js";

/**
 * The R30 fix replaces a pid *number* check with a question about the process
 * itself, so the probe has to hold against the real OS -- not a fake. These
 * cases run the actual platform implementation (Win32_Process / /proc cmdline).
 */
describe("readProcessCommandLine against the running OS", () => {
  it("reports the command line of a live process", async () => {
    const probe = await readProcessCommandLine(process.pid);

    expect(probe.kind).toBe("command_line");
    if (probe.kind !== "command_line") return;
    expect(probe.value.toLowerCase()).toContain("node");
  }, 30_000);

  it("distinguishes a marked child from that same pid after it exits", async () => {
    const marker = "soulstream-r30-probe-marker";
    const child = spawn(
      process.execPath,
      ["-e", `setTimeout(() => {}, 60_000)`, marker],
      { stdio: "ignore" },
    );
    const pid = child.pid;
    expect(pid).toBeTypeOf("number");
    if (pid === undefined) return;

    const live = await readProcessCommandLine(pid);
    expect(live).toMatchObject({ kind: "command_line" });
    if (live.kind !== "command_line") return;
    expect(live.value).toContain(marker);

    child.kill("SIGKILL");
    await once(child, "exit");

    // The number may already be gone or already reissued to a stranger. Either
    // answer is acceptable; claiming our marker back is not.
    const afterExit = await readProcessCommandLine(pid);
    if (afterExit.kind === "command_line") {
      expect(afterExit.value).not.toContain(marker);
    }
  }, 30_000);
});

describe("commandLineOwnedBySession", () => {
  const paths = {
    configPath: "D:\\root\\.local\\runner-state\\843db1ba8c5e\\runner-config.json",
  } as RunnerProcessPaths;

  it("accepts our runner however the OS quoted it", () => {
    expect(commandLineOwnedBySession(
      `"C:\\Program Files\\nodejs\\node.exe" "D:\\root\\releases\\a1\\runner_entry.js" `
      + `--config "d:/root/.local/runner-state/843db1ba8c5e/runner-config.json"`,
      paths,
      "win32",
    )).toBe(true);
  });

  it("rejects a sibling session's runner and a stranger alike", () => {
    expect(commandLineOwnedBySession(
      `node "D:\\root\\releases\\a1\\runner_entry.js" `
      + `--config "D:\\root\\.local\\runner-state\\0f9e8d7c6b5a\\runner-config.json"`,
      paths,
      "win32",
    )).toBe(false);
    expect(commandLineOwnedBySession(
      "C:\\Windows\\System32\\svchost.exe -k NetworkService -p",
      paths,
      "win32",
    )).toBe(false);
  });

  it("keeps path case significant off Windows", () => {
    const linuxPaths = {
      configPath: "/srv/soulstream/.local/runner-state/843db1ba8c5e/runner-config.json",
    } as RunnerProcessPaths;
    const entry = "/srv/soulstream/releases/a1/runner_entry.js";

    expect(commandLineOwnedBySession(
      `node ${entry} --config ${linuxPaths.configPath}`,
      linuxPaths,
      "linux",
    )).toBe(true);
    expect(commandLineOwnedBySession(
      `node ${entry} --config ${linuxPaths.configPath.toUpperCase()}`,
      linuxPaths,
      "linux",
    )).toBe(false);
  });
});
