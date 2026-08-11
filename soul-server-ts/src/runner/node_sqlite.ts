import { createRequire } from "node:module";

import { assertRunnerNodeRuntime } from "./runner_node_runtime_preflight.js";

type NodeSqliteModule = typeof import("node:sqlite");

const requireNodeBuiltin = createRequire(import.meta.url);

export function loadNodeSqlite(): NodeSqliteModule {
  assertRunnerNodeRuntime({
    runnerProcessEnabled: true,
    nodeVersion: process.versions.node,
  });
  return requireNodeBuiltin("node:sqlite") as NodeSqliteModule;
}
