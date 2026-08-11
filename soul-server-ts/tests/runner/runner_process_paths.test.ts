import { describe, expect, it } from "vitest";

import {
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

  it("does not apply the Unix pathname limit to Windows named pipes", () => {
    expect(() => runnerProcessPaths(
      `C:/${"a".repeat(200)}`,
      "session-a",
      "win32",
    )).not.toThrow();
  });
});
