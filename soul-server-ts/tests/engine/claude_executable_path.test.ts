import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { configureClaudeExecutablePath } from "../../src/engine/claude_executable_path.js";

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

describe("Claude executable startup preflight", () => {
  it("accepts the explicit host executable capability", () => {
    const dir = makeTempDirSync("claude-explicit-path-");
    try {
      const executable = join(dir, "claude");
      writeFileSync(executable, "", { mode: 0o755 });

      expect(configureClaudeExecutablePath({
        CLAUDE_CODE_EXECPATH: executable,
        PATH: "",
      }, "linux", { error: vi.fn() })).toBe(executable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canonicalizes a Windows PATH resolution into the child environment capability", () => {
    const dir = makeTempDirSync("claude-configured-path-");
    try {
      const executable = join(dir, "claude.cmd");
      writeFileSync(executable, "", { mode: 0o755 });
      const env: Record<string, string | undefined> = {
        PATH: dir,
        PATHEXT: ".EXE;.CMD",
      };

      expect(configureClaudeExecutablePath(env, "win32", { error: vi.fn() })).toBe(executable);
      expect(env.CLAUDE_CODE_EXECPATH).toBe(executable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails startup with every searched Windows candidate in the diagnosis", () => {
    const dir = makeTempDirSync("claude-missing-path-");
    try {
      const first = join(dir, "npm-a");
      const second = join(dir, "npm-b");
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });

      expect(() => configureClaudeExecutablePath({
        PATH: `${first};${second}`,
        PATHEXT: ".EXE;.CMD",
      }, "win32", { error: vi.fn() })).toThrow(
        new RegExp(
          "Claude Code executable path resolution failed before host startup.*"
            + "claude\\.exe.*claude\\.cmd.*claude\\.exe.*claude\\.cmd",
          "s",
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to PATH when the explicit executable hint is stale", () => {
    const dir = makeTempDirSync("claude-stale-explicit-");
    try {
      const executable = join(dir, "claude");
      writeFileSync(executable, "", { mode: 0o755 });
      const env: Record<string, string | undefined> = {
        CLAUDE_CODE_EXECPATH: join(dir, "deleted-python-release", "claude"),
        PATH: dir,
      };

      expect(configureClaudeExecutablePath(env, "linux", { error: vi.fn() })).toBe(executable);
      expect(env.CLAUDE_CODE_EXECPATH).toBe(executable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs an error before falling back from a stale explicit executable hint", () => {
    const dir = makeTempDirSync("claude-stale-explicit-log-");
    try {
      const executable = join(dir, "claude");
      const stale = join(dir, "deleted-python-release", "claude");
      writeFileSync(executable, "", { mode: 0o755 });
      const logger = { error: vi.fn() };

      configureClaudeExecutablePath({
        CLAUDE_CODE_EXECPATH: stale,
        PATH: dir,
      }, "linux", logger);

      expect(logger.error).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          configuredPath: stale,
          reason: expect.stringMatching(/ENOENT|does not exist/i),
        }),
        expect.stringMatching(/falling back to PATH\/PATHEXT/i),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails startup when neither an explicit hint nor PATH candidates exist", () => {
    expect(() => configureClaudeExecutablePath({
      PATH: "",
    }, "linux", { error: vi.fn() })).toThrow(
      /Source: PATH\/PATHEXT\. Searched candidates: \(no candidates\)/,
    );
  });

  it("darwin에서 PATH 뒤 HOME 설치 위치를 차례로 찾는다", () => {
    const home = makeTempDirSync("claude-darwin-home-");
    try {
      const localBin = join(home, ".local", "bin");
      mkdirSync(localBin, { recursive: true });
      const localCli = join(localBin, "claude");
      writeFileSync(localCli, "", { mode: 0o755 });

      expect(configureClaudeExecutablePath(
        { PATH: "", HOME: home },
        "darwin",
        { error: vi.fn() },
      )).toBe(localCli);

      rmSync(localCli);
      const npmBin = join(home, ".npm-global", "bin");
      mkdirSync(npmBin, { recursive: true });
      const npmCli = join(npmBin, "claude");
      writeFileSync(npmCli, "", { mode: 0o755 });

      expect(configureClaudeExecutablePath(
        { PATH: "", HOME: home },
        "darwin",
        { error: vi.fn() },
      )).toBe(npmCli);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("darwin에서도 PATH 후보가 HOME 설치 위치보다 앞선다", () => {
    const dir = makeTempDirSync("claude-darwin-path-order-");
    const home = makeTempDirSync("claude-darwin-path-home-");
    try {
      const pathCli = join(dir, "claude");
      writeFileSync(pathCli, "", { mode: 0o755 });
      const homeBin = join(home, ".local", "bin");
      mkdirSync(homeBin, { recursive: true });
      writeFileSync(join(homeBin, "claude"), "", { mode: 0o755 });

      expect(configureClaudeExecutablePath(
        { PATH: dir, HOME: home },
        "darwin",
        { error: vi.fn() },
      )).toBe(pathCli);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("darwin에서 HOME이 없으면 Homebrew 접두사를 계속 찾는다", () => {
    addVirtualFile("/opt/homebrew/bin/claude");
    addVirtualFile("/usr/local/bin/claude");

    expect(configureClaudeExecutablePath(
      { PATH: "" },
      "darwin",
      { error: vi.fn() },
    )).toBe("/opt/homebrew/bin/claude");

    resetVirtualFs();
    addVirtualFile("/opt/homebrew/bin/claude", false);
    addVirtualFile("/usr/local/bin/claude");

    expect(configureClaudeExecutablePath(
      { PATH: "" },
      "darwin",
      { error: vi.fn() },
    )).toBe("/usr/local/bin/claude");
  });

  it("darwin에서 후보가 모두 없으면 Homebrew 접두사까지 진단에 남긴다", () => {
    addVirtualFile("/opt/homebrew/bin/claude", false);
    addVirtualFile("/usr/local/bin/claude", false);
    expect(() => configureClaudeExecutablePath({
      PATH: "",
      HOME: "",
    }, "darwin", { error: vi.fn() })).toThrow(
      /\/opt\/homebrew\/bin\/claude.*\/usr\/local\/bin\/claude/s,
    );
  });
});
