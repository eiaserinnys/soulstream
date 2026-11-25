import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { terminateProcessTree } from "../../src/agent_login/process_control.js";
import { waitForChildExit } from "../../src/claude_accounts/login_cli_helpers.js";
import { isAlive } from "./fake_clis.js";

describe("terminateProcessTree", () => {
  it.skipIf(process.platform === "win32")("그룹 리더가 아닌 자식의 본체에도 신호가 닿는다", async () => {
    // detached가 아니라 서버와 같은 그룹이다. -pid는 ESRCH라 본체에 직접 보내야 닿는다.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "ignore", "ignore"] });
    const pid = child.pid!;
    const exit = waitForChildExit(child);
    expect(isAlive(pid)).toBe(true);
    await terminateProcessTree(child, exit, 2_000, 1_000);
    expect(await exit).toMatchObject({ signal: "SIGTERM" });
    expect(isAlive(pid)).toBe(false);
  });
});
