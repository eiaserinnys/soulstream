import { createRequire } from "node:module";

import { nodeSqliteCapabilityError } from "./runner_node_runtime_preflight.js";

type NodeSqliteModule = typeof import("node:sqlite");

const requireNodeBuiltin = createRequire(import.meta.url);

export function loadNodeSqlite(): NodeSqliteModule {
  try {
    return requireNodeBuiltin("node:sqlite") as NodeSqliteModule;
  } catch (cause) {
    throw nodeSqliteCapabilityError({
      nodeVersion: process.versions.node,
      execArgv: process.execArgv,
      cause,
    });
  }
}
