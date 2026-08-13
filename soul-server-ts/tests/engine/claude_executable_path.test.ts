import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  configureClaudeExecutablePath,
  requireClaudeExecutablePath,
} from "../../src/engine/claude_executable_path.js";

describe("Claude executable startup preflight", () => {
  it("accepts the explicit host executable capability", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-explicit-path-"));
    try {
      const executable = join(dir, "claude");
      writeFileSync(executable, "", { mode: 0o755 });

      expect(requireClaudeExecutablePath({
        CLAUDE_CODE_EXECPATH: executable,
        PATH: "",
      }, "linux")).toBe(executable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canonicalizes a Windows PATH resolution into the child environment capability", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-configured-path-"));
    try {
      const executable = join(dir, "claude.cmd");
      writeFileSync(executable, "", { mode: 0o755 });
      const env: Record<string, string | undefined> = {
        PATH: dir,
        PATHEXT: ".EXE;.CMD",
      };

      expect(configureClaudeExecutablePath(env, "win32")).toBe(executable);
      expect(env.CLAUDE_CODE_EXECPATH).toBe(executable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails startup with every searched Windows candidate in the diagnosis", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-missing-path-"));
    try {
      const first = join(dir, "npm-a");
      const second = join(dir, "npm-b");
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });

      expect(() => requireClaudeExecutablePath({
        PATH: `${first};${second}`,
        PATHEXT: ".EXE;.CMD",
      }, "win32")).toThrow(
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
});
