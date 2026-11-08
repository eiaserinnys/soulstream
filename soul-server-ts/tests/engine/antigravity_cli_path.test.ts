import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAntigravityCliPath } from "../../src/engine/antigravity_cli_path.js";
import { makeTempDirSync } from "../helpers/temp_dir.js";
import { addVirtualFile, resetVirtualFs } from "../helpers/virtual_fs.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { virtualFs } = await import("../helpers/virtual_fs.js");
  return virtualFs(actual);
});

afterEach(() => {
  resetVirtualFs();
});

it("resolves explicit, PATH, then HOME local binary without executing it", () => {
  const home = makeTempDirSync("agy-cli-");
  const bin = join(home, ".local/bin"); mkdirSync(bin, { recursive: true });
  const cli = join(bin, "agy"); writeFileSync(cli, "#!/bin/sh\nexit 91\n"); chmodSync(cli, 0o700);
  expect(resolveAntigravityCliPath({ AGY_CLI_PATH: cli, PATH: "", HOME: "" })).toEqual({ path: cli, source: "AGY_CLI_PATH" });
  expect(resolveAntigravityCliPath({ PATH: bin, HOME: "" })).toEqual({ path: cli, source: "PATH" });
  expect(resolveAntigravityCliPath({ PATH: "", HOME: home })).toEqual({ path: cli, source: "HOME_LOCAL_BIN" });
});
it("returns undefined on a node without agy", () => {
  expect(resolveAntigravityCliPath({ AGY_CLI_PATH: "/missing/agy", PATH: "", HOME: "" })).toBeUndefined();
});

it("darwin에서 HOME local, npm global, Homebrew 순서로 찾는다", () => {
  const home = makeTempDirSync("agy-darwin-");
  try {
    const localBin = join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const localCli = join(localBin, "agy");
    writeFileSync(localCli, "#!/bin/sh\n"); chmodSync(localCli, 0o755);

    expect(resolveAntigravityCliPath({ PATH: "", HOME: home }, "darwin")).toEqual({
      path: localCli,
      source: "HOME_LOCAL_BIN",
    });

    rmSync(localCli);
    const npmBin = join(home, ".npm-global", "bin");
    mkdirSync(npmBin, { recursive: true });
    const npmCli = join(npmBin, "agy");
    writeFileSync(npmCli, "#!/bin/sh\n"); chmodSync(npmCli, 0o755);

    expect(resolveAntigravityCliPath({ PATH: "", HOME: home }, "darwin")).toEqual({
      path: npmCli,
      source: "HOME_NPM_GLOBAL",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("darwin에서 HOME이 없으면 Homebrew 접두사를 찾는다", () => {
  addVirtualFile("/opt/homebrew/bin/agy");
  addVirtualFile("/usr/local/bin/agy");

  expect(resolveAntigravityCliPath({ PATH: "", HOME: "" }, "darwin")).toEqual({
    path: "/opt/homebrew/bin/agy",
    source: "HOMEBREW_ARM64_BIN",
  });

  resetVirtualFs();
  addVirtualFile("/opt/homebrew/bin/agy", false);
  addVirtualFile("/usr/local/bin/agy");

  expect(resolveAntigravityCliPath({ PATH: "", HOME: "" }, "darwin")).toEqual({
    path: "/usr/local/bin/agy",
    source: "HOMEBREW_INTEL_BIN",
  });
});
