import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const WORKTREE_ROOT = fileURLToPath(new URL("../src/worktree/", import.meta.url));

/**
 * WSL main-thread samples showed the hourly sweep blocking the event loop for
 * seconds: lock mkdir, the admin directory read, and every gitdir read ran sync.
 * These functions sit on the sweep path and must not call sync fs again.
 */
const ASYNC_ONLY: Record<string, string[]> = {
  "worktree_repository_lock.ts": ["withLock", "reclaimDeadLock"],
  "worktree_git.ts": ["registrationAdmin", "lastWorktreeActivityMs", "pruneMissingWorktree"],
  "worktree_sweep.ts": ["inspectSweepCandidate"],
};

describe("worktree sweep filesystem calls", () => {
  for (const [file, functions] of Object.entries(ASYNC_ONLY)) {
    it(`keeps ${file} sweep functions free of sync fs calls`, () => {
      const bodies = functionBodies(`${WORKTREE_ROOT}${file}`);
      for (const name of functions) {
        const body = bodies.get(name);
        expect(body, `${file}:${name} exists`).toBeDefined();
        expect(syncCalls(body!), `${file}:${name}`).toEqual([]);
      }
    });
  }
});

function functionBodies(path: string): Map<string, ts.Node> {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const bodies = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
      && node.name
      && ts.isIdentifier(node.name)
      && node.body
    ) {
      bodies.set(node.name.text, node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bodies;
}

function syncCalls(body: ts.Node): string[] {
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (name.endsWith("Sync")) calls.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return calls;
}
