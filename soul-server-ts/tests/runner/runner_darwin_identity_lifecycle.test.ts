import { afterEach, describe, expect, it, vi } from "vitest";

import {
  processStartIdentitiesMatch,
  readProcessStartIdentity,
} from "../../src/runner/runner_process_lock.js";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = ((...args: unknown[]) =>
    execFileMock(...args)) as unknown as typeof actual.execFile;
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = async (
    file: string,
    args: readonly string[],
    options: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    await new Promise((resolveProbe, rejectProbe) => {
      execFileMock(file, args, options, (error: unknown, stdout: string, stderr: string) => {
        if (error) rejectProbe(error);
        else resolveProbe({ stdout, stderr });
      });
    });
  return { ...actual, execFile };
});

const DEAD_PID = 4_321;
const LIVE_PID = 4_322;

afterEach(() => {
  execFileMock.mockReset();
  vi.restoreAllMocks();
});

describe("Darwin process start identity", () => {
  it("reads /bin/ps lstart under a fixed locale and timezone", async () => {
    respondWith("Sun Nov  8 01:57:19 2026\n");

    const probe = await readProcessStartIdentity(LIVE_PID, "darwin");

    expect(probe).toEqual({
      kind: "identity",
      value: `darwin-process-${Date.UTC(2026, 10, 8, 1, 57, 19)}`,
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { timeout: number; encoding: string; env: NodeJS.ProcessEnv },
    ];
    expect(file).toBe("/bin/ps");
    expect(args).toEqual(["-p", String(LIVE_PID), "-o", "lstart="]);
    expect(options.timeout).toBe(2_000);
    expect(options.encoding).toBe("utf8");
    expect(options.env.LC_ALL).toBe("C");
    expect(options.env.TZ).toBe("UTC");
  });

  it("accepts a single-digit day with collapsed whitespace padding", async () => {
    respondWith("  Sun Nov 8 02:03:04 2026 \n");

    await expect(readProcessStartIdentity(LIVE_PID, "darwin")).resolves.toEqual({
      kind: "identity",
      value: `darwin-process-${Date.UTC(2026, 10, 8, 2, 3, 4)}`,
    });
  });

  it("turns an empty probe for a dead pid into absence", async () => {
    respondWith("");
    spyOnProcessLiveness(false);

    await expect(readProcessStartIdentity(DEAD_PID, "darwin")).resolves.toEqual({
      kind: "absent",
    });
  });

  it("keeps exit code 1 with a live pid unavailable instead of absent", async () => {
    failWith(Object.assign(new Error("Command failed: ps"), { code: 1 }));
    spyOnProcessLiveness(true);

    await expect(readProcessStartIdentity(LIVE_PID, "darwin")).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("keeps a timed-out probe unavailable", async () => {
    failWith(Object.assign(new Error("Command failed: ps"), { code: null, killed: true }));

    await expect(readProcessStartIdentity(LIVE_PID, "darwin")).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("keeps an unparsable probe unavailable", async () => {
    respondWith("not-a-process-start-time\n");

    await expect(readProcessStartIdentity(LIVE_PID, "darwin")).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("rejects a non-positive pid before probing", async () => {
    await expect(readProcessStartIdentity(0, "darwin")).rejects.toThrow(
      /process start identity pid must be positive/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("Darwin process start identity matching", () => {
  it("matches the same Darwin identity exactly", () => {
    expect(processStartIdentitiesMatch(
      "darwin-process-1700000000123",
      "darwin-process-1700000000123",
    )).toBe(true);
    expect(processStartIdentitiesMatch(
      "darwin-process-1700000000123",
      "darwin-process-1700000003123",
    )).toBe(false);
  });

  it("keeps the two-second fallback tolerance against node-start", () => {
    const darwinEpochMs = 1_700_000_000_000;
    expect(processStartIdentitiesMatch(
      `node-start-${darwinEpochMs}`,
      `darwin-process-${darwinEpochMs + 2_000}`,
    )).toBe(true);
    expect(processStartIdentitiesMatch(
      `node-start-${darwinEpochMs}`,
      `darwin-process-${darwinEpochMs + 2_001}`,
    )).toBe(false);
  });
});

function respondWith(stdout: string): void {
  execFileMock.mockImplementation((
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: unknown, stdout: string, stderr: string) => void,
  ) => {
    callback(null, stdout, "");
  });
}

function failWith(error: unknown): void {
  execFileMock.mockImplementation((
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: unknown, stdout: string, stderr: string) => void,
  ) => {
    callback(error, "", "");
  });
}

function spyOnProcessLiveness(alive: boolean): void {
  vi.spyOn(process, "kill").mockImplementation(() => {
    if (alive) return true;
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  });
}
