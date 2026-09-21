import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GitProcessError,
  runBoundedProcess,
} from "../src/worktree/worktree_process.js";
import { RepositoryLock } from "../src/worktree/worktree_repository_lock.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bounded worktree processes", () => {
  it("kills the whole process tree before returning a timeout", async () => {
      const root = mkdtempSync(join(tmpdir(), "worktree-process-"));
      roots.push(root);
      const marker = join(root, "late-marker");
      const grandchild = [
        "const fs=require('fs')",
        "process.on('SIGTERM',()=>{})",
        `setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)}, 'late'), 250)`,
        "setInterval(()=>{}, 1000)",
      ].join(";");
      const parent = [
        "const {spawn}=require('child_process')",
        `spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'})`,
        "process.on('SIGTERM',()=>process.exit(0))",
        "setInterval(()=>{}, 1000)",
      ].join(";");

      await expect(runBoundedProcess({
        command: process.execPath,
        args: ["-e", parent],
        cwd: root,
        timeoutMs: 40,
      })).rejects.toMatchObject({ code: "PROCESS_TIMEOUT", terminationConfirmed: true });

      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(existsSync(marker)).toBe(false);
  });

  it("releases the repository lock only after confirmed process termination", async () => {
    const root = mkdtempSync(join(tmpdir(), "worktree-lock-"));
    roots.push(root);
    const lock = new RepositoryLock({ lockRoot: root, defaultTimeoutMs: 500 });

    await expect(lock.withLock("repo-a", async () => {
      throw new GitProcessError("PROCESS_TIMEOUT", "timed out", true);
    })).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });

    await expect(lock.withLock("repo-a", async () => "reacquired"))
      .resolves.toBe("reacquired");
  });

  it("preserves lock evidence when process termination cannot be confirmed", async () => {
    const root = mkdtempSync(join(tmpdir(), "worktree-unconfirmed-lock-"));
    roots.push(root);
    const lock = new RepositoryLock({ lockRoot: root, defaultTimeoutMs: 60 });

    await expect(lock.withLock("repo-b", async () => {
      throw new GitProcessError("PROCESS_TIMEOUT", "unconfirmed", false);
    })).rejects.toMatchObject({ terminationConfirmed: false });
    await expect(lock.withLock("repo-b", async () => "must not run"))
      .rejects.toMatchObject({ code: "REPOSITORY_LOCK_TIMEOUT" });
  });

  it("reclaims a lock whose recorded owner process is gone", async () => {
    const root = mkdtempSync(join(tmpdir(), "worktree-stale-lock-"));
    roots.push(root);
    const key = "repo-stale";
    const lockPath = join(
      root,
      `${createHash("sha256").update(key).digest("hex")}.lock`,
    );
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      acquiredAt: new Date(0).toISOString(),
      key,
    }));
    const lock = new RepositoryLock({ lockRoot: root, defaultTimeoutMs: 500 });

    await expect(lock.withLock(key, async () => "recovered"))
      .resolves.toBe("recovered");
  });
});
