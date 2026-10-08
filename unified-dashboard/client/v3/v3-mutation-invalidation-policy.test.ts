import { readdirSync, readFileSync } from "node:fs";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_DIRECTORY = new URL("./", import.meta.url);

function productionSources(): URL[] {
  return readdirSync(SOURCE_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => /\.(?:ts|tsx)$/.test(entry.name))
    .filter((entry) => !/\.(?:test|qa)\.(?:ts|tsx)$/.test(entry.name))
    .map((entry) => new URL(entry.name, SOURCE_DIRECTORY));
}

type LiteralValue = string | boolean | string[];
type LiteralRecord = Record<string, LiteralValue>;
type RefetchCallRecord = {
  file: string;
  receiver: string | null;
  inRecoveryCallback: boolean;
  filters: LiteralRecord | null;
  options: LiteralRecord | null;
  argumentCount: number;
};

function literalValue(expression: ts.Expression): LiteralValue | null {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(expression)) {
    const values: string[] = [];
    for (const element of expression.elements) {
      if (!ts.isStringLiteralLike(element)) return null;
      values.push(element.text);
    }
    return values;
  }
  return null;
}

function literalRecord(expression: ts.Expression | undefined): LiteralRecord | null {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return null;
  const record: LiteralRecord = {};
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) return null;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : null;
    const value = literalValue(property.initializer);
    if (name === null || value === null || Object.prototype.hasOwnProperty.call(record, name)) {
      return null;
    }
    record[name] = value;
  }
  return record;
}

function isRecoveryRegistrationCallback(node: ts.Node): boolean {
  if (
    !ts.isArrowFunction(node) ||
    !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    return false;
  }
  const registration = node.parent;
  return (
    ts.isCallExpression(registration) &&
    ts.isIdentifier(registration.expression) &&
    registration.expression.text === "registerConnectionRecovery" &&
    registration.arguments[0] === node
  );
}

function isInsideRecoveryCallback(call: ts.CallExpression): boolean {
  let ancestor: ts.Node | undefined = call;
  while (ancestor) {
    if (isRecoveryRegistrationCallback(ancestor)) return true;
    ancestor = ancestor.parent;
  }
  return false;
}

function refetchCallRecords(file: string, sourceText: string): RefetchCallRecord[] {
  const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const calls: RefetchCallRecord[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "refetchQueries"
    ) {
      calls.push({
        file,
        receiver: ts.isIdentifier(node.expression.expression)
          ? node.expression.expression.text
          : null,
        inRecoveryCallback: isInsideRecoveryCallback(node),
        filters: literalRecord(node.arguments[0]),
        options: literalRecord(node.arguments[1]),
        argumentCount: node.arguments.length,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

const EXPECTED_REFETCH_CALLS: RefetchCallRecord[] = [
  {
    file: "V3DashboardLayout.tsx",
    receiver: "queryClient",
    inRecoveryCallback: true,
    filters: { queryKey: ["v3-review-queue"], type: "active" },
    options: { cancelRefetch: false, throwOnError: true },
    argumentCount: 2,
  },
  {
    file: "V3DashboardLayout.tsx",
    receiver: "queryClient",
    inRecoveryCallback: true,
    filters: { queryKey: ["sessions"], type: "active" },
    options: { cancelRefetch: false, throwOnError: true },
    argumentCount: 2,
  },
];

describe("v3 mutation invalidation policy", () => {
  it("forbids broad local invalidation from every v3 production source", () => {
    for (const sourceUrl of productionSources()) {
      const source = readFileSync(sourceUrl, "utf8");
      expect(source, sourceUrl.pathname).not.toMatch(/invalidateLocal/);
      expect(source, sourceUrl.pathname).not.toMatch(/invalidateV3\s*\(\s*["']local["']/);
    }
  });

  it("forbids direct query-cache invalidation and reset primitives from every v3 production source", () => {
    for (const sourceUrl of productionSources()) {
      const source = readFileSync(sourceUrl, "utf8");
      expect(source, sourceUrl.pathname).not.toMatch(
        /\b(?:invalidateQueries|resetQueries|removeQueries)\s*\(/,
      );
    }
  });

  it("allows only the two active refetches in connection recovery", () => {
    const calls = productionSources().flatMap((sourceUrl) => {
      const file = sourceUrl.pathname.slice(sourceUrl.pathname.lastIndexOf("/") + 1);
      return refetchCallRecords(file, readFileSync(sourceUrl, "utf8"));
    });

    expect(calls).toEqual(EXPECTED_REFETCH_CALLS);
  });

  it("distinguishes recovery calls from same-key calls outside it and unscoped calls", () => {
    const reviewQueueCall =
      'queryClient.refetchQueries({queryKey: ["v3-review-queue"], type: "active"}, {cancelRefetch: false, throwOnError: true});';
    const sessionsCall =
      'queryClient.refetchQueries({queryKey: ["sessions"], type: "active"}, {cancelRefetch: false, throwOnError: true});';
    const validFixture =
      "registerConnectionRecovery(async () => {\n  " +
      reviewQueueCall +
      "\n  " +
      sessionsCall +
      "\n});";
    const movedOutsideFixture =
      "registerConnectionRecovery(async () => {\n  " +
      sessionsCall +
      "\n});\n" +
      reviewQueueCall;
    const unscopedFixture =
      "registerConnectionRecovery(async () => {\n  " +
      reviewQueueCall +
      "\n  " +
      sessionsCall +
      '\n  queryClient.refetchQueries({type: "active"}, {cancelRefetch: false, throwOnError: true});\n});';
    const validCalls = refetchCallRecords("V3DashboardLayout.tsx", validFixture);
    const movedCalls = refetchCallRecords("V3DashboardLayout.tsx", movedOutsideFixture);
    const unscopedCalls = refetchCallRecords("V3DashboardLayout.tsx", unscopedFixture);

    expect(validCalls).toEqual(EXPECTED_REFETCH_CALLS);
    expect(movedCalls).not.toEqual(EXPECTED_REFETCH_CALLS);
    expect(movedCalls[1].filters).toEqual({ queryKey: ["v3-review-queue"], type: "active" });
    expect(movedCalls[1].inRecoveryCallback).toBe(false);
    expect(unscopedCalls).not.toEqual(EXPECTED_REFETCH_CALLS);
    expect(unscopedCalls).toHaveLength(3);
    expect(unscopedCalls[2].filters).toEqual({ type: "active" });
  });

  it("does not expose a broad local source in the live invalidation plane", () => {
    const source = readFileSync(new URL("./v3-live-invalidation-plane.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/["']local["']/);
  });
});
