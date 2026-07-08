import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BoardYjsHostProxyFixture,
  DbFunctionContractFixture,
  FakeNodeReconnectFixture,
  OrchContractFixtures,
  RouteInventoryFixture,
  SseReplayGapFixture,
  UpstreamWsWireFixture,
} from "./types.js";

export const CONTRACT_FIXTURE_NAMES = [
  "routeInventory",
  "upstreamWsWire",
  "sseReplayGap",
  "fakeNodeReconnect",
  "boardYjsHostProxy",
  "dbFunctionContract",
] as const;

const FIXTURE_FILES = {
  routeInventory: "route_inventory.json",
  upstreamWsWire: "upstream_ws_wire.json",
  sseReplayGap: "sse_replay_gap.json",
  fakeNodeReconnect: "fake_node_reconnect.json",
  boardYjsHostProxy: "board_yjs_host_proxy.json",
  dbFunctionContract: "db_function_contract.json",
} as const;

export function resolveContractFixtureDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "../../../orch-server/tests/fixtures/orch_contract"),
    resolve(process.cwd(), "../orch-server/tests/fixtures/orch_contract"),
    resolve(process.cwd(), "orch-server/tests/fixtures/orch_contract"),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`orch contract fixture directory not found: ${candidates.join(", ")}`);
  }
  return found;
}

export function loadContractFixture<T>(name: string, fixtureDir = resolveContractFixtureDir()): T {
  const path = resolve(fixtureDir, name);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadContractFixtures(fixtureDir = resolveContractFixtureDir()): OrchContractFixtures {
  return {
    routeInventory: loadContractFixture<RouteInventoryFixture>(
      FIXTURE_FILES.routeInventory,
      fixtureDir,
    ),
    upstreamWsWire: loadContractFixture<UpstreamWsWireFixture>(
      FIXTURE_FILES.upstreamWsWire,
      fixtureDir,
    ),
    sseReplayGap: loadContractFixture<SseReplayGapFixture>(FIXTURE_FILES.sseReplayGap, fixtureDir),
    fakeNodeReconnect: loadContractFixture<FakeNodeReconnectFixture>(
      FIXTURE_FILES.fakeNodeReconnect,
      fixtureDir,
    ),
    boardYjsHostProxy: loadContractFixture<BoardYjsHostProxyFixture>(
      FIXTURE_FILES.boardYjsHostProxy,
      fixtureDir,
    ),
    dbFunctionContract: loadContractFixture<DbFunctionContractFixture>(
      FIXTURE_FILES.dbFunctionContract,
      fixtureDir,
    ),
  };
}
