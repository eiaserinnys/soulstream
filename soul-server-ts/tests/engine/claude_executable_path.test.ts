import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { configureClaudeExecutablePath } from "../../src/engine/claude_executable_path.js";

import { makeTempDirSync } from "../helpers/temp_dir.js";

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
});
