import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DARWIN_UNIX_SOCKET_PATH_MAX_BYTES,
  isRunnerRegistrationDirectoryName,
  LINUX_UNIX_SOCKET_PATH_MAX_BYTES,
  runnerProcessPaths,
} from "../../src/runner/runner_process_paths.js";

describe("runner process path portability", () => {
  it("accepts the exact Linux sockaddr_un pathname boundary", () => {
    const paths = runnerProcessPaths(`/${"a".repeat(69)}`, "session-a", "linux");
    expect(Buffer.byteLength(paths.socketPath, "utf8")).toBe(
      LINUX_UNIX_SOCKET_PATH_MAX_BYTES,
    );
  });

  it("rejects a Linux runner socket pathname above 107 bytes", () => {
    expect(() => runnerProcessPaths(
      `/${"a".repeat(70)}`,
      "session-a",
      "linux",
    )).toThrow(/SOUL_RUNNER_STATE_DIR.*108 byte runner socket path.*107/);
  });

  it("accepts the exact Darwin sockaddr_un pathname boundary", () => {
    const paths = runnerProcessPaths(`/${"a".repeat(65)}`, "session-a", "darwin");
    expect(Buffer.byteLength(paths.socketPath, "utf8")).toBe(
      DARWIN_UNIX_SOCKET_PATH_MAX_BYTES,
    );
    expect(paths.socketKind).toBe("unix_socket");
  });

  it("rejects a Darwin runner socket pathname above 103 bytes", () => {
    expect(() => runnerProcessPaths(
      `/${"a".repeat(66)}`,
      "session-a",
      "darwin",
    )).toThrow(/SOUL_RUNNER_STATE_DIR.*104 byte runner socket path.*103/);
  });

  it("measures the Darwin limit in UTF-8 bytes for non-ASCII state directories", () => {
    expect(() => runnerProcessPaths(
      `/${"가".repeat(20)}`,
      "session-a",
      "darwin",
    )).not.toThrow();
    expect(() => runnerProcessPaths(
      `/${"가".repeat(23)}`,
      "session-a",
      "darwin",
    )).toThrow(/107 byte runner socket path.*103/);
  });

  it("rejects a long real /var/folders state directory on Darwin", () => {
    const macStateDirectory =
      "/var/folders/2x/8m1y3k5v6b7n9q0r2s4t6u8w0000gn/T/soulstream-runner-state";
    expect(() => runnerProcessPaths(
      macStateDirectory,
      "session-a",
      "darwin",
    )).toThrow(/109 byte runner socket path.*103/);
  });

  it("does not apply the Unix pathname limit to Windows named pipes", () => {
    expect(() => runnerProcessPaths(
      `C:/${"a".repeat(200)}`,
      "session-a",
      "win32",
    )).not.toThrow();
  });

  it("keeps the stable session-derived Windows runner pipe name", () => {
    const sessionId = "same-session";
    const sessionHash = createHash("sha256")
      .update(sessionId)
      .digest("hex")
      .slice(0, 24);
    expect(runnerProcessPaths("C:/state", sessionId, "win32").socketPath)
      .toBe(`\\\\.\\pipe\\soulstream-runner-${sessionHash}`);
  });

  it("reserves underscore-prefixed names for runner-state infrastructure", () => {
    expect(isRunnerRegistrationDirectoryName("_control")).toBe(false);
    expect(isRunnerRegistrationDirectoryName("_future-infrastructure")).toBe(false);
    expect(isRunnerRegistrationDirectoryName("0123456789abcdef01234567")).toBe(true);
    expect(isRunnerRegistrationDirectoryName("damaged-registration")).toBe(true);
  });
});
