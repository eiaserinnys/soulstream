import { describe, expect, it, vi } from "vitest";

import {
  SESSION_ENGINE_OOM_SCORE_ADJ,
  setSessionEngineOomScore,
} from "../../src/engine/session_engine_oom_score.js";

describe("session engine OOM score", () => {
  it("writes the Linux child process oom_score_adj", async () => {
    const writeFile = vi.fn(async () => undefined);
    const warn = vi.fn();

    const applied = await setSessionEngineOomScore(4321, {
      platform: "linux",
      writeFile,
      logger: { warn },
    });

    expect(applied).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(
      "/proc/4321/oom_score_adj",
      String(SESSION_ENGINE_OOM_SCORE_ADJ),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("does nothing outside Linux", async () => {
    const writeFile = vi.fn(async () => undefined);
    const warn = vi.fn();

    const applied = await setSessionEngineOomScore(4321, {
      platform: "win32",
      writeFile,
      logger: { warn },
    });

    expect(applied).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and continues when procfs rejects the write", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const writeFile = vi.fn(async () => { throw error; });
    const warn = vi.fn();

    const applied = await setSessionEngineOomScore(4321, {
      platform: "linux",
      writeFile,
      logger: { warn },
    });

    expect(applied).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      { err: error, pid: 4321, path: "/proc/4321/oom_score_adj" },
      "Failed to raise session engine OOM score",
    );
  });
});
