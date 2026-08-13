import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const LIFECYCLE_PATH = fileURLToPath(new URL(
  "../src/runner/sqlite_runner_lifecycle.ts",
  import.meta.url,
));
const OUTBOX_PATH = fileURLToPath(new URL(
  "../src/runner/sqlite_event_outbox.ts",
  import.meta.url,
));

const LIFECYCLE_MUTATIONS = [
  "begin",
  "progress",
  "liveness",
  "toolStarted",
  "toolFinished",
  "finish",
  "reap",
] as const;

describe("runner SQLite write inventory", () => {
  it("keeps every lifecycle mutation behind the async transaction seam", () => {
    const source = readFileSync(LIFECYCLE_PATH, "utf8");
    for (const mutation of LIFECYCLE_MUTATIONS) {
      expect(source, mutation).toMatch(new RegExp(`\\n  async ${mutation}\\(`));
    }
    expect(source).toContain("private async transaction<T>(");
    expect(source).toContain("withRunnerSqliteTransaction(");
    expect(source).not.toContain("withRunnerSqliteTransactionSync");
  });

  it("freezes every raw lifecycle write owner", () => {
    expect(sqliteWriteOwners(LIFECYCLE_PATH)).toEqual({
      beginWithinTransaction: 3,
      updateActiveWithinTransaction: 2,
      updateBootstrapWithinTransaction: 1,
    });
  });

  it("allows synchronous transactions only for migrations inside retried database open", () => {
    expect(syncTransactionCallers(SRC_ROOT)).toEqual({
      "runner/sqlite_intervention_inbox.ts": ["migrateRunnerInterventionInboxV9"],
      "runner/sqlite_ipc_journal.ts": ["ensureRunnerIpcJournalV4"],
    });

    const outboxSource = readFileSync(OUTBOX_PATH, "utf8");
    const retriedOpen = outboxSource.slice(
      outboxSource.indexOf("private static async openDatabase("),
      outboxSource.indexOf("\n  get streamId(): string"),
    );
    expect(retriedOpen).toContain("await withRunnerSqliteBusyRetry(() => {");
    expect(retriedOpen).toContain("ensureRunnerIpcJournalV4(database);");
    expect(retriedOpen).toContain("migrateRunnerInterventionInboxV9(database, version);");
  });
});

function syncTransactionCallers(root: string): Record<string, string[]> {
  const callers: Record<string, string[]> = {};
  for (const path of collectTypeScriptFiles(root)) {
    if (path.endsWith("runner_sqlite_connection.ts")) continue;
    const source = parseSource(path);
    const functions = new Set<string>();
    const visit = (node: ts.Node, owner = "module"): void => {
      const nextOwner = declarationName(node) ?? owner;
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "withRunnerSqliteTransactionSync"
      ) functions.add(nextOwner);
      ts.forEachChild(node, (child) => visit(child, nextOwner));
    };
    visit(source);
    if (functions.size > 0) {
      callers[relative(root, path)] = [...functions].sort();
    }
  }
  return Object.fromEntries(Object.entries(callers).sort(([left], [right]) =>
    left.localeCompare(right)));
}

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function sqliteWriteOwners(path: string): Record<string, number> {
  const source = parseSource(path);
  const owners: Record<string, number> = {};

  const visit = (node: ts.Node, owner = "module"): void => {
    const nextOwner = declarationName(node) ?? owner;
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ["run", "exec"].includes(node.expression.name.text)
    ) {
      owners[nextOwner] = (owners[nextOwner] ?? 0) + 1;
    }
    ts.forEachChild(node, (child) => visit(child, nextOwner));
  };
  visit(source);
  return Object.fromEntries(Object.entries(owners).sort(([left], [right]) =>
    left.localeCompare(right)));
}

function parseSource(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function declarationName(node: ts.Node): string | undefined {
  if (
    (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node))
    && node.name
  ) return node.name.getText();
  return undefined;
}
