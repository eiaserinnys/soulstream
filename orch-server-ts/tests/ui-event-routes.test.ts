import { describe, expect, it } from "vitest";

import {
  UI_EVENT_SCHEMA_VERSION,
  createApp,
  parseOrchServerConfig,
  type StoredUiEvent,
  type UiEventCollectionConfig,
  type UiEventIdentity,
  type UiEventQuery,
  type UiEventRepository,
  type UiEventRouteOptions,
  type UiEventRow,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const ENABLED: UiEventCollectionConfig = {
  enabled: true,
  flushIntervalMs: 10_000,
  maxBatchSize: 20,
  maxQueueSize: 500,
};

type FakeRepository = UiEventRepository & {
  readonly stored: UiEventRow[];
  readonly queries: UiEventQuery[];
  pruneCalls: number;
};

function createFakeRepository(
  overrides: { config?: UiEventCollectionConfig; rows?: readonly StoredUiEvent[] } = {},
): FakeRepository {
  const stored: UiEventRow[] = [];
  const queries: UiEventQuery[] = [];
  const repository: FakeRepository = {
    stored,
    queries,
    pruneCalls: 0,
    readConfig: async () => overrides.config ?? ENABLED,
    insertBatch: async (rows) => {
      const inserted: string[] = [];
      for (const row of rows) {
        // 실제 ON CONFLICT DO NOTHING 과 같은 규칙: 이미 있는 event_id 는 빠진다.
        if (stored.some((existing) => existing.eventId === row.eventId)) continue;
        stored.push(row);
        inserted.push(row.eventId);
      }
      return inserted;
    },
    query: async (query) => {
      queries.push(query);
      return (overrides.rows ?? []).slice(0, query.limit);
    },
    listInstalls: async () => [],
    pruneExpired: async () => {
      repository.pruneCalls += 1;
      return 0;
    },
  };
  return repository;
}

function createTestApp(
  repository: UiEventRepository,
  options: {
    identity?: UiEventIdentity | null;
    now?: () => number;
    pruneIntervalMs?: number;
  } = {},
) {
  const identity = options.identity === undefined
    ? { email: "owner@example.com", clientKind: "browser" as const }
    : options.identity;
  const routeOptions: UiEventRouteOptions = {
    repository,
    resolveIdentity: () => identity,
    ...(options.now ? { now: options.now } : {}),
    ...(options.pruneIntervalMs !== undefined
      ? { pruneIntervalMs: options.pruneIntervalMs }
      : {}),
  };
  return createApp({ config, uiEventRoutes: routeOptions });
}

function batch(events: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaVersion: UI_EVENT_SCHEMA_VERSION,
    installId: "install-a",
    clientSessionKey: "tab-a",
    appVersion: "2026.09.21+test",
    events,
  };
}

function viewOpen(eventId: string, seq: number): Record<string, unknown> {
  return {
    eventId,
    seq,
    occurredAt: "2026-09-21T00:00:00.000Z",
    type: "view_open",
    target: { kind: "session", id: "session-1" },
    from: { kind: "folder", id: "folder-1" },
    entry: "sidebar",
  };
}

const ID_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ID_B = "bbbbbbbb-2222-4222-8222-222222222222";

describe("ui event ingest", () => {
  it("stays unregistered until the route options are supplied", async () => {
    const app = createApp({ config });
    expect(await app.inject({ method: "POST", url: "/api/ui-events" }))
      .toMatchObject({ statusCode: 404 });
    await app.close();
  });

  it("stores a batch and reports what it accepted", async () => {
    const repository = createFakeRepository();
    const app = createTestApp(repository);

    const response = await app.inject({
      method: "POST",
      url: "/api/ui-events",
      payload: batch([viewOpen(ID_A, 1), viewOpen(ID_B, 2)]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
    expect(repository.stored).toHaveLength(2);
    await app.close();
  });

  it("takes the user and the client kind from the credential, never from the body", async () => {
    const repository = createFakeRepository();
    const app = createTestApp(repository, {
      identity: { email: "owner@example.com", clientKind: "soul-app" },
    });

    await app.inject({
      method: "POST",
      url: "/api/ui-events",
      payload: {
        ...batch([viewOpen(ID_A, 1)]),
        userEmail: "attacker@example.com",
        clientKind: "browser",
      },
    });

    expect(repository.stored[0]).toMatchObject({
      userEmail: "owner@example.com",
      clientKind: "soul-app",
    });
    await app.close();
  });

  it("counts a resent event as a duplicate instead of storing it twice", async () => {
    const repository = createFakeRepository();
    const app = createTestApp(repository);
    const payload = batch([viewOpen(ID_A, 1)]);

    await app.inject({ method: "POST", url: "/api/ui-events", payload });
    const second = await app.inject({ method: "POST", url: "/api/ui-events", payload });

    expect(second.json()).toEqual({ accepted: 0, duplicates: 1, rejected: [] });
    expect(repository.stored).toHaveLength(1);
    await app.close();
  });

  it("collapses a duplicate that arrives twice inside one batch", async () => {
    const repository = createFakeRepository();
    const app = createTestApp(repository);

    const response = await app.inject({
      method: "POST",
      url: "/api/ui-events",
      payload: batch([viewOpen(ID_A, 1), viewOpen(ID_A, 1)]),
    });

    expect(response.json()).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
    await app.close();
  });

  it("rejects one bad event and still stores the good ones", async () => {
    // 한 건이 나쁘다고 배치를 통째로 되돌리면 클라이언트가 영구 재시도에 갇힌다.
    const repository = createFakeRepository();
    const app = createTestApp(repository);

    const response = await app.inject({
      method: "POST",
      url: "/api/ui-events",
      payload: batch([
        viewOpen(ID_A, 1),
        { ...viewOpen(ID_B, 2), type: "compose_abandon", flowId: "c1", attrs: {
          draftPresent: true, draftLength: 4, draftText: "초안 원문",
        } },
      ]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 1,
      duplicates: 0,
      rejected: [{ eventId: ID_B, reason: "unknown_attr:draftText" }],
    });
    expect(repository.stored).toHaveLength(1);
    await app.close();
  });

  it("never lets draft text reach storage", async () => {
    const repository = createFakeRepository();
    const app = createTestApp(repository);

    await app.inject({
      method: "POST",
      url: "/api/ui-events",
      payload: batch([{
        ...viewOpen(ID_A, 1),
        type: "compose_abandon",
        flowId: "compose-1",
        attrs: { draftPresent: true, draftLength: 42 },
      }]),
    });

    expect(JSON.stringify(repository.stored)).not.toContain("draftText");
    expect(repository.stored[0]?.attrs).toEqual({ draftPresent: true, draftLength: 42 });
    await app.close();
  });

  it("refuses a batch larger than the contract allows", async () => {
    const repository = createFakeRepository();
    const app = createTestApp(repository);
    const events = Array.from({ length: 51 }, (_unused, index) =>
      viewOpen(`aaaaaaaa-1111-4111-8111-${String(index).padStart(12, "0")}`, index + 1));

    const response = await app.inject({
      method: "POST",
      url: "/api/ui-events",
      payload: batch(events),
    });

    expect(response.statusCode).toBe(413);
    expect(repository.stored).toHaveLength(0);
    await app.close();
  });

  it("refuses an envelope that is missing its identifiers", async () => {
    const app = createTestApp(createFakeRepository());
    const response = await app.inject({
      method: "POST",
      url: "/api/ui-events",
      payload: { ...batch([viewOpen(ID_A, 1)]), installId: "" },
    });
    expect(response.statusCode).toBe(422);
    await app.close();
  });

  it("refuses an envelope from an unknown schema version", async () => {
    const app = createTestApp(createFakeRepository());
    const response = await app.inject({
      method: "POST",
      url: "/api/ui-events",
      payload: { ...batch([viewOpen(ID_A, 1)]), schemaVersion: "soulstream.ui_event.v99" },
    });
    expect(response.statusCode).toBe(422);
    await app.close();
  });

  it("accepts and discards the batch while collection is switched off", async () => {
    // 끄자마자 클라이언트를 4xx 루프에 빠뜨리지 않는다.
    const repository = createFakeRepository({ config: { ...ENABLED, enabled: false } });
    const app = createTestApp(repository);

    const response = await app.inject({
      method: "POST",
      url: "/api/ui-events",
      payload: batch([viewOpen(ID_A, 1)]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: 0, disabled: true });
    expect(repository.stored).toHaveLength(0);
    await app.close();
  });

  it("turns an unauthenticated caller away", async () => {
    const app = createTestApp(createFakeRepository(), { identity: null });
    const response = await app.inject({
      method: "POST",
      url: "/api/ui-events",
      payload: batch([viewOpen(ID_A, 1)]),
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("ui event retention", () => {
  it("prunes once per interval instead of once per request", async () => {
    const repository = createFakeRepository();
    let clock = 1_000_000;
    const app = createTestApp(repository, {
      now: () => clock,
      pruneIntervalMs: 60_000,
    });
    const send = (eventId: string) =>
      app.inject({ method: "POST", url: "/api/ui-events", payload: batch([viewOpen(eventId, 1)]) });

    await send(ID_A);
    await send(ID_B);
    expect(repository.pruneCalls).toBe(1);

    clock += 60_001;
    await send("cccccccc-3333-4333-8333-333333333333");
    expect(repository.pruneCalls).toBe(2);
    await app.close();
  });
});

describe("ui event read api", () => {
  const storedEvent: StoredUiEvent = {
    eventId: ID_A,
    seq: 1,
    occurredAt: "2026-09-21T00:00:00.000Z",
    receivedAt: "2026-09-21T00:00:01.000Z",
    clientKind: "browser",
    installId: "install-a",
    clientSessionKey: "tab-a",
    appVersion: "2026.09.21+test",
    type: "view_open",
    target: { kind: "session", id: "session-1" },
    from: null,
    entry: "sidebar",
    flowId: null,
    attrs: {},
  };

  it("scopes every read to the authenticated caller", async () => {
    const repository = createFakeRepository({ rows: [storedEvent] });
    const app = createTestApp(repository, {
      identity: { email: "owner@example.com", clientKind: "browser" },
    });

    await app.inject({
      method: "GET",
      // 쿼리로 남의 이메일을 밀어 넣어도 무시된다.
      url: "/api/ui-events?from=2026-09-20T00:00:00Z&to=2026-09-22T00:00:00Z"
        + "&userEmail=someone-else@example.com",
    });

    expect(repository.queries[0]?.userEmail).toBe("owner@example.com");
    await app.close();
  });

  it("passes the date, device and target filters through", async () => {
    const repository = createFakeRepository({ rows: [] });
    const app = createTestApp(repository);

    await app.inject({
      method: "GET",
      url: "/api/ui-events?from=2026-09-20T00:00:00Z&to=2026-09-22T00:00:00Z"
        + "&installId=install-a&clientKind=soul-app&targetKind=task&targetId=task-9",
    });

    expect(repository.queries[0]).toMatchObject({
      from: "2026-09-20T00:00:00Z",
      to: "2026-09-22T00:00:00Z",
      installId: "install-a",
      clientKind: "soul-app",
      targetKind: "task",
      targetId: "task-9",
    });
    await app.close();
  });

  it("requires a bounded range", async () => {
    const app = createTestApp(createFakeRepository());
    expect(await app.inject({ method: "GET", url: "/api/ui-events" }))
      .toMatchObject({ statusCode: 422 });
    expect(await app.inject({
      method: "GET",
      url: "/api/ui-events?from=2026-09-22T00:00:00Z&to=2026-09-20T00:00:00Z",
    })).toMatchObject({ statusCode: 422 });
    await app.close();
  });

  it("offers a cursor only while more rows remain", async () => {
    const rows = Array.from({ length: 3 }, (_unused, index) => ({
      ...storedEvent,
      eventId: `aaaaaaaa-1111-4111-8111-${String(index).padStart(12, "0")}`,
      occurredAt: `2026-09-21T00:0${index}:00.000Z`,
    }));
    const repository = createFakeRepository({ rows });
    const app = createTestApp(repository);

    const page = await app.inject({
      method: "GET",
      url: "/api/ui-events?from=2026-09-20T00:00:00Z&to=2026-09-22T00:00:00Z&limit=2",
    });

    const body = page.json();
    expect(body.events).toHaveLength(2);
    expect(body.nextCursor).toBe(`2026-09-21T00:01:00.000Z|${rows[1]?.eventId}`);
    // limit+1 을 읽어야 다음 페이지 존재를 알 수 있다.
    expect(repository.queries[0]?.limit).toBe(3);
    await app.close();
  });

  it("reports no cursor on the last page", async () => {
    const repository = createFakeRepository({ rows: [storedEvent] });
    const app = createTestApp(repository);
    const page = await app.inject({
      method: "GET",
      url: "/api/ui-events?from=2026-09-20T00:00:00Z&to=2026-09-22T00:00:00Z&limit=2",
    });
    expect(page.json().nextCursor).toBeNull();
    await app.close();
  });

  it("serves the collection settings with the schema version", async () => {
    const app = createTestApp(createFakeRepository());
    const response = await app.inject({ method: "GET", url: "/api/ui-events/config" });
    expect(response.json()).toEqual({
      ...ENABLED,
      schemaVersion: UI_EVENT_SCHEMA_VERSION,
    });
    await app.close();
  });

  it("keeps the config route distinct from the event list route", async () => {
    const repository = createFakeRepository();
    const app = createTestApp(repository);
    await app.inject({ method: "GET", url: "/api/ui-events/config" });
    // config 가 목록 라우트로 새면 여기에 조회가 쌓인다.
    expect(repository.queries).toHaveLength(0);
    await app.close();
  });

  it("turns an unauthenticated reader away", async () => {
    const app = createTestApp(createFakeRepository(), { identity: null });
    expect(await app.inject({
      method: "GET",
      url: "/api/ui-events?from=2026-09-20T00:00:00Z&to=2026-09-22T00:00:00Z",
    })).toMatchObject({ statusCode: 401 });
    await app.close();
  });
});
