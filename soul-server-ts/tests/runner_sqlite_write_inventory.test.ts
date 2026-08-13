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
const INTERVENTION_PATH = fileURLToPath(new URL(
  "../src/runner/sqlite_intervention_inbox.ts",
  import.meta.url,
));
const CUTOVER_E2E_PATH = fileURLToPath(new URL(
  "./runner/runner_cutover_integration.e2e.test.ts",
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
  it("keeps child lifecycle mutations short and synchronous without retry masking", () => {
    const source = readFileSync(LIFECYCLE_PATH, "utf8");
    for (const mutation of LIFECYCLE_MUTATIONS) {
      expect(source, mutation).toMatch(new RegExp(`\\n  ${mutation}\\(`));
    }
    expect(source).toContain("private transaction<T>(");
    expect(source).toContain("withRunnerSqliteTransactionSync(");
    expect(source).not.toContain("withRunnerSqliteTransaction(");
  });

  it("freezes every raw lifecycle write owner", () => {
    expect(sqliteWriteOwners(LIFECYCLE_PATH)).toEqual({
      beginWithinTransaction: 3,
      updateActiveWithinTransaction: 2,
      updateBootstrapWithinTransaction: 1,
    });
  });

  it("freezes every synchronous transaction owner", () => {
    expect(syncTransactionCallers(SRC_ROOT)).toEqual({
      "runner/runner_host_state_store.ts": ["transaction"],
      "runner/sqlite_intervention_inbox.ts": ["migrateRunnerInterventionInboxV9"],
      "runner/sqlite_ipc_journal.ts": ["ensureRunnerIpcJournalV4"],
      "runner/sqlite_runner_lifecycle.ts": ["transaction"],
    });
  });

  it("freezes every writable runner.sqlite opener and its ownership boundary", () => {
    expect(classMethodCallers(SRC_ROOT, "RunnerSqliteEventOutbox", ["open", "create"], [
      OUTBOX_PATH,
    ])).toEqual({
      "runner/runner_child_runtime.ts": ["start"],
      "runner/runner_intervention_resolution.ts": ["resolveAmbiguousRunnerIntervention"],
      "runner/runner_process_dispatcher.ts": ["initialize"],
      "runner/runner_process_spawn.ts": ["defaultDependencies"],
      "runner/runner_release_prewarm.ts": ["module"],
    });
    expect(classMethodCallers(SRC_ROOT, "RunnerSqliteLifecycle", ["open"])).toEqual({
      "runner/runner_child_runtime.ts": ["start"],
      "runner/runner_recovery_task.ts": ["markRegistrationReaped"],
    });

    const dispatcher = readFileSync(resolve(SRC_ROOT, "runner/runner_process_dispatcher.ts"), "utf8");
    const offline = dispatcher.slice(
      dispatcher.indexOf("if (this.options.offlineExisting)"),
      dispatcher.indexOf("const spawner ="),
    );
    expect(offline.indexOf("RunnerWriterLock.acquire")).toBeLessThan(
      offline.indexOf("RunnerSqliteEventOutbox.open"),
    );
    expect(dispatcher).toContain("RunnerParentOutbox.open(");

    const recovery = readFileSync(resolve(SRC_ROOT, "runner/runner_recovery_task.ts"), "utf8");
    const reap = recovery.slice(recovery.indexOf("function markRegistrationReaped("));
    expect(reap.indexOf("RunnerWriterLock.acquire")).toBeLessThan(
      reap.indexOf("RunnerSqliteLifecycle.open"),
    );
  });

  it("keeps active parent reads free of hidden runner.sqlite writes", () => {
    expect(sqliteWriteOwnersForFunction(
      INTERVENTION_PATH,
      "readPendingRunnerInterventions",
    )).toEqual({});
    for (const relativePath of [
      "runner/runner_parent_outbox.ts",
      "runner/runner_process_registry.ts",
      "runner/closed_runner_tail_drainer.ts",
    ]) {
      const source = readFileSync(resolve(SRC_ROOT, relativePath), "utf8");
      expect(source, relativePath).not.toContain("RunnerSqliteEventOutbox.open(");
      expect(source, relativePath).not.toContain("RunnerSqliteLifecycle.open(");
    }
    const registry = readFileSync(
      resolve(SRC_ROOT, "runner/runner_process_registry.ts"),
      "utf8",
    );
    const inspection = registry.slice(
      registry.indexOf("export async function inspectRunnerDurableState("),
      registry.indexOf("function isPidAlive("),
    );
    expect(inspection).toContain("RunnerSqliteEventOutbox.openReadOnly(");
    expect(inspection).toContain("readRunnerHostAcknowledgedThrough(");
    expect(inspection).not.toContain("RunnerParentOutbox.open(");
    expect(inspection).not.toContain("RunnerHostStateStore.open(");
  });

  it("keeps the rolling-restart E2E observer read-only", () => {
    const source = readFileSync(CUTOVER_E2E_PATH, "utf8");
    expect(source).not.toContain("RunnerSqliteEventOutbox.create(");
    expect(source).not.toContain("RunnerSqliteEventOutbox.open(");
    expect(source).toContain("RunnerSqliteEventOutbox.openReadOnly(");
  });
});

function classMethodCallers(
  root: string,
  className: string,
  methodNames: string[],
  excludedPaths: string[] = [],
): Record<string, string[]> {
  const callers: Record<string, string[]> = {};
  for (const path of collectTypeScriptFiles(root)) {
    if (excludedPaths.includes(path)) continue;
    const source = parseSource(path);
    const functions = new Set<string>();
    const visit = (node: ts.Node, owner = "module"): void => {
      const nextOwner = declarationName(node) ?? owner;
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === className
        && methodNames.includes(node.expression.name.text)
      ) functions.add(nextOwner);
      ts.forEachChild(node, (child) => visit(child, nextOwner));
    };
    visit(source);
    if (functions.size > 0) callers[relative(root, path)] = [...functions].sort();
  }
  return Object.fromEntries(Object.entries(callers).sort(([left], [right]) =>
    left.localeCompare(right)));
}

function sqliteWriteOwnersForFunction(path: string, functionName: string): Record<string, number> {
  const source = parseSource(path);
  const declaration = source.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === functionName);
  if (!declaration) throw new Error(`function unavailable: ${functionName}`);
  const owners: Record<string, number> = {};
  const visit = (node: ts.Node, owner = functionName): void => {
    const nextOwner = declarationName(node) ?? owner;
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ["run", "exec"].includes(node.expression.name.text)
    ) owners[nextOwner] = (owners[nextOwner] ?? 0) + 1;
    ts.forEachChild(node, (child) => visit(child, nextOwner));
  };
  visit(declaration);
  return owners;
}

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
