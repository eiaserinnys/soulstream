import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertCleanSourceTree,
  assertCommitHash,
  readSourceCommit,
} from "../../src/release/portable_pack_source.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("portable pack source tree", () => {
  it("reads HEAD and accepts a clean commit", async () => {
    const repository = await createRepository();

    expect(() => assertCleanSourceTree(repository)).not.toThrow();
    expect(readSourceCommit(repository)).toBe(git(repository, "rev-parse", "HEAD"));
  });

  it("refuses a tracked modification", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "main.js"), "// changed\n", "utf8");

    expect(() => assertCleanSourceTree(repository))
      .toThrow(/source tree is dirty[\s\S]*main\.js/);
  });

  it("refuses an untracked file git does not ignore", async () => {
    const repository = await createRepository();
    await mkdir(join(repository, "chunks"), { recursive: true });
    await writeFile(join(repository, "chunks/vendor.js"), "// stray\n", "utf8");

    // git collapses an untracked directory to `?? chunks/`; the point is that
    // a file git would otherwise let slip into the pack still disqualifies it.
    expect(() => assertCleanSourceTree(repository))
      .toThrow(/source tree is dirty[\s\S]*chunks\//);
  });

  it("accepts ignored build output beside a clean commit", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, ".gitignore"), "dist-portable/\n", "utf8");
    git(repository, "add", ".gitignore");
    git(repository, "commit", "-m", "ignore build output");
    await mkdir(join(repository, "dist-portable"), { recursive: true });
    await writeFile(join(repository, "dist-portable", "main.js"), "// built\n", "utf8");

    expect(() => assertCleanSourceTree(repository)).not.toThrow();
  });
});

describe("portable pack commit label", () => {
  it("accepts a hexadecimal commit and refuses anything else", () => {
    expect(assertCommitHash("1e098b8c9")).toBe("1e098b8c9");
    expect(() => assertCommitHash("--source-commit")).toThrow(/not a commit hash/);
    expect(() => assertCommitHash("HEAD")).toThrow(/not a commit hash/);
  });
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "portable-pack-source-"));
  temporaryDirectories.push(repository);
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "portable-pack@example.invalid");
  git(repository, "config", "user.name", "Portable Pack Test");
  await writeFile(join(repository, "main.js"), "// main\n", "utf8");
  git(repository, "add", "main.js");
  git(repository, "commit", "-q", "-m", "initial");
  return repository;
}

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}
