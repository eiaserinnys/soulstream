import { execFileSync } from "node:child_process";

/**
 * The portable payload is labelled with `source_commit` and startup trusts
 * that label, so the bytes must be exactly that commit. These helpers are the
 * one place that decides what "the source tree" is for the packer: tracked
 * changes and untracked files git does not ignore both disqualify it. There is
 * no override and no bypass flag — a dirty tree has no commit to label.
 */
export function assertCleanSourceTree(repositoryRoot: string): void {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  if (status.length > 0) {
    throw new Error(
      "the source tree is dirty; a portable payload must be packed from a clean "
      + `commit:\n${status}`,
    );
  }
}

export function readSourceCommit(repositoryRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

export function assertCommitHash(value: string): string {
  if (!/^[0-9a-f]{7,64}$/.test(value)) {
    throw new Error(`git HEAD is not a commit hash: ${value}`);
  }
  return value;
}
