import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAntigravityCliPath } from "../src/llm/antigravity_cli_path.js";

describe("optional Antigravity CLI resolution", () => {
  it("prefers configured path, PATH, then home local bin; missing CLI stays optional", () => {
    const directory = mkdtempSync(join(tmpdir(), "agy-path-test-"));
    const executable = (path: string) => { writeFileSync(path, "#!/bin/sh\n"); chmodSync(path, 0o755); return path; };
    try {
      mkdirSync(join(directory, ".local", "bin"), { recursive: true });
      const explicit = executable(join(directory, "explicit"));
      const path = executable(join(directory, "agy"));
      const home = executable(join(directory, ".local", "bin", "agy"));
      const env = { PATH: directory, HOME: directory };
      expect(resolveAntigravityCliPath(explicit, env)).toEqual({ path: explicit, source: "AGY_CLI_PATH" });
      expect(resolveAntigravityCliPath(join(directory, "missing"), env)).toEqual({ path, source: "PATH" });
      expect(resolveAntigravityCliPath(null, { ...env, PATH: "" })).toEqual({ path: home, source: "HOME_LOCAL_BIN" });
      expect(resolveAntigravityCliPath(null, {})).toBeUndefined();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
