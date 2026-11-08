import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAntigravityCliPath } from "../src/llm/antigravity_cli_path.js";
import { addVirtualFile, resetVirtualFs } from "./helpers/virtual_fs.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { virtualFs } = await import("./helpers/virtual_fs.js");
  return virtualFs(actual);
});

afterEach(() => {
  resetVirtualFs();
});

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

  it("finds the npm global and Homebrew installs on Darwin", () => {
    const home = mkdtempSync(join(tmpdir(), "agy-darwin-test-"));
    const executable = (path: string) => { writeFileSync(path, "#!/bin/sh\n"); chmodSync(path, 0o755); return path; };
    try {
      const npmBin = join(home, ".npm-global", "bin");
      mkdirSync(npmBin, { recursive: true });
      const npmCli = executable(join(npmBin, "agy"));

      expect(resolveAntigravityCliPath(null, { PATH: "", HOME: home }, "darwin"))
        .toEqual({ path: npmCli, source: "HOME_NPM_GLOBAL" });
    } finally { rmSync(home, { recursive: true, force: true }); }

    addVirtualFile("/opt/homebrew/bin/agy");
    addVirtualFile("/usr/local/bin/agy");
    expect(resolveAntigravityCliPath(null, { PATH: "" }, "darwin"))
      .toEqual({ path: "/opt/homebrew/bin/agy", source: "HOMEBREW_ARM64_BIN" });

    resetVirtualFs();
    addVirtualFile("/opt/homebrew/bin/agy", false);
    addVirtualFile("/usr/local/bin/agy");
    expect(resolveAntigravityCliPath(null, { PATH: "" }, "darwin"))
      .toEqual({ path: "/usr/local/bin/agy", source: "HOMEBREW_INTEL_BIN" });
  });
});
