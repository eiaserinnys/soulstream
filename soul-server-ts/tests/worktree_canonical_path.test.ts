import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalWorktreePath } from "../src/worktree/worktree_canonical_path.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "worktree-canonical-"));
  roots.push(root);
  return root;
}

describe("canonicalWorktreePath", () => {
  it("returns the real path of an existing directory", () => {
    const root = makeRoot();
    const real = join(root, "real");
    mkdirSync(real);

    expect(canonicalWorktreePath(real)).toBe(realpathSync(real));
  });

  it("keeps a missing suffix below the real path of the nearest existing ancestor", () => {
    const root = makeRoot();
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link, "dir");

    expect(canonicalWorktreePath(join(link, "worktree--branch")))
      .toBe(join(realpathSync(real), "worktree--branch"));
  });

  it("resolves an existing symlink to its target", () => {
    const root = makeRoot();
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link, "dir");

    expect(canonicalWorktreePath(link)).toBe(realpathSync(real));
  });

  it("propagates a non-ENOENT error instead of walking up", () => {
    const root = makeRoot();
    const file = join(root, "file");
    writeFileSync(file, "not a directory\n");

    expect(() => canonicalWorktreePath(join(file, "child"))).toThrow(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });
});
