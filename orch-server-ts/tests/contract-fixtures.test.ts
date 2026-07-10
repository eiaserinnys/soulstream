import { describe, expect, it } from "vitest";

import {
  CONTRACT_FIXTURE_FILES,
  CONTRACT_FIXTURE_NAMES,
  contractFixtureSummary,
  inferFakeNodeReconnectSteps,
  loadContractFixtures,
  routeOwnerManifest,
  staticBeforeDynamicHazards,
} from "../src/index.js";

describe("orch-server-ts contract fixture reader", () => {
  const fixtures = loadContractFixtures();

  it("loads the full #289 fixture pack from the Python orch contract directory", () => {
    expect(Object.keys(fixtures).sort()).toEqual([...CONTRACT_FIXTURE_NAMES].sort());
    expect(Object.values(CONTRACT_FIXTURE_FILES).sort()).toEqual([
      "board_yjs_host_proxy.json",
      "db_function_contract.json",
      "fake_node_reconnect.json",
      "route_inventory.json",
      "sse_replay_gap.json",
      "upstream_ws_wire.json",
    ]);

    for (const fixture of Object.values(fixtures)) {
      expect(fixture.version).toBe(1);
    }
  });

  it("keeps route inventory count, public routes, and static-before-dynamic hazards visible", () => {
    const summary = contractFixtureSummary(fixtures);

    expect(summary.routeCount).toBe(121);
    expect(summary.publicRoutes).toEqual([
      "/api/auth/config",
      "/api/auth/dev-login",
      "/api/auth/google",
      "/api/auth/google/callback",
      "/api/auth/google/native",
      "/api/auth/logout",
      "/api/auth/status",
      "/api/config",
      "/api/health",
      "/ws/node",
    ]);
    expect(staticBeforeDynamicHazards(fixtures.routeInventory)).toEqual([
      {
        staticPath: "/api/sessions/{session_id}/events/viewport",
        dynamicPath: "/api/sessions/{session_id}/events",
      },
      {
        staticPath: "/api/runbooks/my-turn",
        dynamicPath: "/api/runbooks/{runbook_id}",
      },
    ]);
  });

  it("keeps upstream WS respond and subscribe_events semantics explicit", () => {
    expect(fixtures.upstreamWsWire.outbound.respond).toMatchObject({
      type: "respond",
      inputRequestId: "input-req-contract",
      requestId: "<orch-command-request-id>",
      requestIdMustNotEqual: "inputRequestId",
    });
    expect(fixtures.upstreamWsWire.outbound.subscribeEvents).toMatchObject({
      type: "subscribe_events",
      requestId: "<absent>",
      fireAndForget: true,
    });
  });

  it("keeps SSE replay, gap, and snapshot refetch metadata explicit", () => {
    const { common, sessionStream, taskStream, gap } = fixtures.sseReplayGap;

    expect(common.snapshotRefetchOn).toEqual(["ring_gap", "instance_mismatch"]);
    expect(common.resumeInputs).toMatchObject({
      lastEventIdHeader: "1",
      lastEventIdQuery: "1",
      instanceIdQuery: "<current-instance-id>",
    });
    expect(common.streamMeta).toMatchObject({
      type: "stream_meta",
      latest_id: 3,
    });
    expect(sessionStream.events).toHaveLength(3);
    expect(taskStream.changes).toHaveLength(3);
    expect(gap).toMatchObject({
      ringMaxlen: 2,
      lastEventIdBeforeOldest: 0,
      expectedLatestId: 3,
    });
  });

  it("keeps fake node reconnect scenario as register-ack-relay-reconnect-update", () => {
    expect(inferFakeNodeReconnectSteps(fixtures.fakeNodeReconnect)).toEqual([
      "register",
      "ack",
      "relay",
      "disconnect",
      "reconnect",
      "sessions_update",
    ]);
    expect(fixtures.fakeNodeReconnect.sessionsUpdateAfterReconnect.sessions).toHaveLength(1);
  });

  it("keeps board Y.Doc host proxy cardinality and no-direct-mutation contract", () => {
    expect(fixtures.boardYjsHostProxy.cardinality).toEqual({
      zeroHostsStatus: 503,
      twoHostsStatus: 503,
      oneHostStatus: 200,
    });
    expect(fixtures.boardYjsHostProxy.proxy.forwardedHeaders).toContain("authorization");
    expect(fixtures.boardYjsHostProxy.directOperations).toHaveLength(10);
    expect(new Set(
      fixtures.boardYjsHostProxy.directOperations.map((item) => item.operation),
    ).size).toBe(10);
    expect(fixtures.boardYjsHostProxy.negativeAssertions).toContain(
      "catalog_service.create_markdown_document is not called for markdown write routes",
    );
  });

  it("keeps DB function contract signatures for the orchestrator boundary", () => {
    const functions = new Map(
      fixtures.dbFunctionContract.functions.map((fn) => [fn.name, fn]),
    );

    expect(functions.get("session_register")?.args).toContain(
      "p_notify_completion BOOLEAN DEFAULT TRUE",
    );
    expect(functions.get("event_append")?.args).toContain(
      "p_dedupe_key TEXT DEFAULT NULL",
    );
    expect(functions.get("board_item_get_all")?.returns).toContain("container_kind TEXT");
    expect(functions.get("supervisor_event_append")?.returns).toContain("gap_start INTEGER");
  });

  it("starts with a planning-only route owner manifest, not a production split owner map", () => {
    expect(routeOwnerManifest.artifactOnly).toBe(true);
    expect(routeOwnerManifest.entries).toEqual([]);
  });
});
