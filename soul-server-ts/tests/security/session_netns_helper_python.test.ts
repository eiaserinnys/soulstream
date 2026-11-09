import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const helperScriptPath = fileURLToPath(
  new URL("../../scripts/session-netns-helper.py", import.meta.url),
);
const probeScriptPath = fileURLToPath(
  new URL("../helpers/session_isolation_helper_probe.py", import.meta.url),
);

const python3Available = spawnSync("python3", ["-c", "print(1)"], {
  encoding: "utf8",
  timeout: 20_000,
}).status === 0;

interface ProbeStatus {
  status: string;
  message?: string;
}

interface ProbeResult {
  case: string;
  outcome: "completed" | "failed";
  message?: string;
  status: ProbeStatus[];
  calls?: number[][];
  events?: string[];
  code?: number;
  argv?: string[];
  start_bwrap_path?: string;
  waited?: boolean;
  status_fd_open_at_wait?: boolean;
  readiness_fd_closed_after?: boolean;
}

function runProbe(caseName: string): ProbeResult {
  const probe = spawnSync("python3", [probeScriptPath, helperScriptPath, caseName], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(probe.stderr).toBe("");
  expect(probe.status).toBe(0);
  return JSON.parse(probe.stdout) as ProbeResult;
}

describe.skipIf(!python3Available)("session-netns-helper.py", () => {
  it("compiles under python3", () => {
    const compiled = spawnSync(
      "python3",
      ["-c", "import sys; compile(open(sys.argv[1]).read(), sys.argv[1], 'exec')", helperScriptPath],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(compiled.stderr).toBe("");
    expect(compiled.status).toBe(0);
  });

  it("arms the parent death signal with PR_SET_PDEATHSIG and SIGKILL", () => {
    const result = runProbe("parent-death-armed");

    expect(result.outcome).toBe("completed");
    // PR_SET_PDEATHSIG = 1, SIGKILL = 9 (linux/prctl.h).
    expect(result.calls).toEqual([[1, 9]]);
    expect(result.status).toEqual([]);
  });

  it("refuses to start when prctl fails", () => {
    const result = runProbe("parent-death-prctl-fails");

    expect(result.outcome).toBe("failed");
    expect(result.message).toMatch(/prctl\(PR_SET_PDEATHSIG\) failed/);
    expect(result.status[0]?.status).toBe("error");
  });

  it("refuses to start when the parent changed while arming", () => {
    const result = runProbe("parent-death-parent-changed");

    expect(result.outcome).toBe("failed");
    expect(result.message).toMatch(/parent process died before the parent-death signal was armed/);
  });

  it("inserts the JSON status fd right after the bwrap executable", () => {
    const result = runProbe("insert-status-fd");

    expect(result.outcome).toBe("completed");
    expect(result.argv).toEqual([
      "/usr/bin/setpriv",
      "/usr/bin/bwrap",
      "--json-status-fd",
      "9",
      "--unshare-pid",
    ]);
  });

  it("refuses an argv that does not reference bwrap exactly once", () => {
    const result = runProbe("insert-status-fd-missing-bwrap");

    expect(result.outcome).toBe("failed");
    expect(result.message).toMatch(/does not reference the bwrap executable exactly once/);
  });

  it("emits network-ready only after both sandbox evidence points", () => {
    const result = runProbe("sandbox-order");

    expect(result.outcome).toBe("completed");
    // start → child-pid 대기 → ready 바이트 대기 → network-ready → CLI 대기.
    expect(result.events).toEqual(["start", "await-child", "await-exec", "wait"]);
    expect(result.code).toBe(7);
    expect(result.status).toEqual([{ status: "network-ready" }]);
    expect(result.start_bwrap_path).toBe("/usr/bin/bwrap");
    expect(result.start_argv).toEqual(["/usr/bin/bwrap"]);
  });

  it("keeps the status fd open until the sandbox child exits", () => {
    // bwrap은 CLI 종료 뒤 `{"exit-code": N}`을 같은 fd에 쓴다. 그 전에 읽기
    // 끝을 닫으면 bwrap이 SIGPIPE로 죽어 정상 세션이 243으로 보고된다.
    const result = runProbe("sandbox-order");

    expect(result.status_fd_open_at_wait).toBe(true);
  });

  it("closes the readiness fd after the launch finishes", () => {
    const result = runProbe("sandbox-order");

    expect(result.readiness_fd_closed_after).toBe(true);
  });

  it("inserts the ready shim right after the bwrap command separator", () => {
    const result = runProbe("exec-shim-insert");

    expect(result.outcome).toBe("completed");
    expect(result.argv).toEqual([
      "/usr/bin/setpriv",
      "/usr/bin/bwrap",
      "--chdir",
      "/w",
      "--",
      "/bin/sh",
      "-c",
      'printf x >&9; exec 9>&-; exec "$@"',
      "/bin/sh",
      "/usr/bin/python3",
      "/w/payload.py",
    ]);
  });

  it("refuses a launch argv without a command separator", () => {
    const result = runProbe("exec-shim-missing-separator");

    expect(result.outcome).toBe("failed");
    expect(result.message).toMatch(/no command separator after the bwrap executable/);
  });

  it("refuses readiness when bwrap dies before the shim byte", () => {
    const result = runProbe("sandbox-exec-eof");

    expect(result.outcome).toBe("failed");
    expect(result.message).toMatch(/bwrap exited with 1 before starting the sandbox command/);
    expect(result.events).toEqual(["start", "await-child"]);
    expect(result.status.map((entry) => entry.status)).toEqual(["error"]);
  });

  it("accepts the shim byte as the sandbox-ready signal", () => {
    const result = runProbe("sandbox-exec-byte");

    expect(result.outcome).toBe("completed");
    expect(result.events).toEqual(["start", "await-child", "wait"]);
    expect(result.code).toBe(7);
    expect(result.status).toEqual([{ status: "network-ready" }]);
  });

  it("refuses readiness when the shim byte never arrives", () => {
    const result = runProbe("sandbox-exec-timeout");

    expect(result.outcome).toBe("failed");
    expect(result.message).toMatch(/the sandbox command did not start within 50ms/);
    expect(result.status.map((entry) => entry.status)).toEqual(["error"]);
  });

  it("emits no network-ready when the handshake fails", () => {
    const result = runProbe("sandbox-handshake-fails");

    expect(result.outcome).toBe("failed");
    expect(result.message).toMatch(/bwrap exited with 1 before starting the sandbox command/);
    expect(result.events).toEqual(["start"]);
    expect(result.status.map((entry) => entry.status)).toEqual(["error"]);
  });

  it("fails the handshake when bwrap exits without reporting", () => {
    const result = runProbe("await-sandbox-eof");

    expect(result.outcome).toBe("failed");
    expect(result.message).toMatch(/bwrap exited with 9 before starting the sandbox command/);
  });

  it("accepts the child-pid report without waiting for the child", () => {
    const result = runProbe("await-sandbox-report");

    expect(result.outcome).toBe("completed");
    expect(result.waited).toBe(false);
    expect(result.status).toEqual([]);
  });
});
