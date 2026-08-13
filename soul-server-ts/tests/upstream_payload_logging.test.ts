import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import pino, { type Logger } from "pino";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../src/agent_registry.js";
import type { TaskExecutor } from "../src/task/task_executor.js";
import type { TaskManager } from "../src/task/task_manager.js";
import { UpstreamAdapter } from "../src/upstream/adapter.js";

const SOUL_PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = join(SOUL_PACKAGE_ROOT, "..");
const SOURCE_ROOT = join(SOUL_PACKAGE_ROOT, "src");
const LOGGING_PACKAGE_ROOTS = [
  SOUL_PACKAGE_ROOT,
  join(REPOSITORY_ROOT, "orch-server-ts"),
];
const RAW_PAYLOAD_FIELD_NAMES = new Set([
  "data",
  "cmd",
  "payload",
  "frame",
  "body",
  "sessions",
  "catalog",
  "events",
  "batch",
  "args",
  "response",
]);
const ALLOWED_RESPONSE_DIAGNOSTICS = new Set([
  // This is the non-2xx response body, not the outbound frame or a collection.
  "task/completion_notifier.ts:body",
]);

describe("upstream failure payload logging", () => {
  it("logs only a bounded summary when a large sessions update is dropped", async () => {
    const warn = vi.fn();
    const logger = {
      ...pino({ level: "silent" }),
      warn,
    } as unknown as Logger;
    const adapter = new UpstreamAdapter(
      {
        url: "ws://orchestrator.invalid/ws/node",
        nodeId: "node-a",
        host: "127.0.0.1",
        port: 4105,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      logger,
      {
        agentRegistry: new AgentRegistry([]),
        taskManager: {} as TaskManager,
        taskExecutor: {} as TaskExecutor,
      },
    );
    const secret = "must-not-appear-in-log".repeat(20_000);
    const payload = {
      type: "sessions_update",
      sessions: [{ session_id: "session-a", prompt: secret }],
    };

    await adapter.sendBroadcast(payload);

    expect(warn).toHaveBeenCalledWith(
      {
        messageType: "sessions_update",
        payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
        itemCount: 1,
        itemCountField: "sessions",
      },
      "Cannot send — WebSocket not open",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("must-not-appear-in-log");
  });

  it("keeps raw payload-like fields out of warning and error log objects", async () => {
    const files = await listTypeScriptFiles(SOURCE_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      offenders.push(...findRawPayloadLogFields(file, source));
    }

    expect(offenders.filter((entry) => !ALLOWED_RESPONSE_DIAGNOSTICS.has(entry))).toEqual([]);
  });

  it("uses the pino err key for Error-bearing warning and error fields", () => {
    const offenders = LOGGING_PACKAGE_ROOTS.flatMap(findMiskeyedErrorLogFields);

    expect(offenders).toEqual([]);
  });

  it("preserves an Error reason through pino serialization", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = pino(destination);
    const error = Object.assign(new Error("runner recovery failed"), {
      code: "SQLITE_BUSY",
    });

    logger.error(
      { err: error, sessionId: "session-a", disposition: "closed" },
      "runner recovery action failed",
    );

    expect(JSON.parse(output)).toMatchObject({
      err: {
        type: "Error",
        message: "runner recovery failed",
        stack: expect.stringContaining("runner recovery failed"),
        code: "SQLITE_BUSY",
      },
      sessionId: "session-a",
      disposition: "closed",
      msg: "runner recovery action failed",
    });
  });
});

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function findRawPayloadLogFields(file: string, source: string): string[] {
  const relativePath = file.slice(SOURCE_ROOT.length + 1);
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const offenders: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === "warn" || node.expression.name.text === "error")
      && node.arguments[0]
      && ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const property of node.arguments[0].properties) {
        const name = propertyName(property);
        if (name && RAW_PAYLOAD_FIELD_NAMES.has(name)) offenders.push(`${relativePath}:${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return offenders;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if (!ts.isPropertyAssignment(property)) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
  return undefined;
}

function findMiskeyedErrorLogFields(packageRoot: string): string[] {
  const configPath = join(packageRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const sourceRoot = join(packageRoot, "src");
  const offenders: string[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.fileName.startsWith(`${sourceRoot}/`)) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && (node.expression.name.text === "warn" || node.expression.name.text === "error")
        && node.arguments[0]
        && !ts.isStringLiteralLike(node.arguments[0])
      ) {
        const argument = node.arguments[0];
        const argumentType = checker.getTypeAtLocation(argument);
        for (const key of ["error", "e", "cause"] as const) {
          const property = checker.getPropertyOfType(argumentType, key);
          if (!property) continue;
          const propertyType = checker.getTypeOfSymbolAtLocation(
            property,
            property.valueDeclaration ?? argument,
          );
          if (!couldBeError(propertyType, checker)) continue;
          const line = sourceFile.getLineAndCharacterOfPosition(argument.getStart()).line + 1;
          offenders.push(
            `${sourceFile.fileName.slice(REPOSITORY_ROOT.length + 1)}:${line}:${key}:${checker.typeToString(propertyType)}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return offenders.sort();
}

function couldBeError(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.isUnion()) return type.types.some((member) => couldBeError(member, checker));
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  const name = type.getSymbol()?.getName();
  if (name === "Error" || name?.endsWith("Error")) return true;
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  return checker.getBaseTypes(type as ts.InterfaceType)?.some(
    (base) => couldBeError(base, checker),
  ) ?? false;
}
