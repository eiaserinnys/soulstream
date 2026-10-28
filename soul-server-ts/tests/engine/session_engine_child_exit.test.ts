import { describe, expect, it } from "vitest";
import pino from "pino";

import { spawnClaudeSessionEngine } from "../../src/engine/session_engine_oom_score.js";

describe("Claude session engine child exit tracking", () => {
  it("settles only after the child exits and stderr closes", async () => {
    let childClosed: Promise<void> | undefined;
    const child = spawnClaudeSessionEngine({
      command: process.execPath,
      args: ["-e", "process.stderr.write('stderr-tail'); setTimeout(() => {}, 10);"],
      cwd: process.cwd(),
      env: process.env,
      signal: undefined,
    }, pino({ level: "silent" }), (closed) => { childClosed = closed; });

    expect(childClosed).toBeDefined();
    await childClosed;
    expect(child.exitCode).toBe(0);
  });
});
