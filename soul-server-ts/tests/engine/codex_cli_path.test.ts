import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCodexCliPath } from "../../src/engine/codex_cli_path.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-cli-path-"));
  tempDirs.push(dir);
  return dir;
}

function makeExecutable(path: string): void {
  writeFileSync(path, "#!/usr/bin/env node\n");
  chmodSync(path, 0o755);
}

function makeFile(path: string): void {
  writeFileSync(path, "echo codex\n");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveCodexCliPath", () => {
  it("CODEX_CLI_PATH가 있으면 파일 존재 여부와 무관하게 정본으로 사용한다", () => {
    expect(
      resolveCodexCliPath({
        CODEX_CLI_PATH: "/opt/codex/bin/codex",
        PATH: "",
        HOME: "",
      }),
    ).toEqual({ path: "/opt/codex/bin/codex", source: "CODEX_CLI_PATH" });
  });

  it("PATH에서 실행 가능한 codex를 찾는다", () => {
    const dir = makeTempDir();
    const codex = join(dir, "codex");
    makeExecutable(codex);

    expect(resolveCodexCliPath({ PATH: dir, HOME: "" })).toEqual({
      path: codex,
      source: "PATH",
    });
  });

  it("Windows PATH에서 extensionless bash shim 대신 codex.cmd를 선택한다", () => {
    const dir = makeTempDir();
    const bashShim = join(dir, "codex");
    const cmdShim = join(dir, "codex.cmd");
    makeFile(bashShim);
    makeFile(cmdShim);

    expect(resolveCodexCliPath({ PATH: dir, HOME: "" }, "win32")).toEqual({
      path: cmdShim,
      source: "PATH",
    });
  });

  it("Windows Path 키도 PATH처럼 처리한다", () => {
    const dir = makeTempDir();
    const cmdShim = join(dir, "codex.cmd");
    makeFile(cmdShim);

    expect(resolveCodexCliPath({ Path: dir }, "win32")).toEqual({
      path: cmdShim,
      source: "PATH",
    });
  });

  it("Windows APPDATA npm fallback에서 codex.cmd를 찾는다", () => {
    const appData = makeTempDir();
    const npmDir = join(appData, "npm");
    const cmdShim = join(npmDir, "codex.cmd");
    mkdirSync(npmDir, { recursive: true });
    makeFile(cmdShim);

    expect(
      resolveCodexCliPath(
        { PATH: "", APPDATA: appData, USERPROFILE: "" },
        "win32",
      ),
    ).toEqual({
      path: cmdShim,
      source: "WINDOWS_APPDATA_NPM",
    });
  });

  it("Windows USERPROFILE npm fallback에서 codex.cmd를 찾는다", () => {
    const userProfile = makeTempDir();
    const npmDir = join(userProfile, "AppData", "Roaming", "npm");
    const cmdShim = join(npmDir, "codex.cmd");
    mkdirSync(npmDir, { recursive: true });
    makeFile(cmdShim);

    expect(
      resolveCodexCliPath(
        { PATH: "", APPDATA: "", USERPROFILE: userProfile },
        "win32",
      ),
    ).toEqual({
      path: cmdShim,
      source: "WINDOWS_USERPROFILE_NPM",
    });
  });

  it("PATH에 없으면 HOME의 npm global 설치 위치를 찾는다", () => {
    const home = makeTempDir();
    const binDir = join(home, ".npm-global", "bin");
    const codex = join(binDir, "codex");
    mkdirSync(binDir, { recursive: true });
    makeExecutable(codex);

    expect(resolveCodexCliPath({ PATH: "", HOME: home })).toEqual({
      path: codex,
      source: "HOME_NPM_GLOBAL",
    });
  });

  it("실행 권한이 없으면 후보를 무시한다", () => {
    const dir = makeTempDir();
    const codex = join(dir, "codex");
    writeFileSync(codex, "#!/usr/bin/env node\n");
    chmodSync(codex, 0o644);

    expect(resolveCodexCliPath({ PATH: dir, HOME: "" })).toBeUndefined();
  });
});
