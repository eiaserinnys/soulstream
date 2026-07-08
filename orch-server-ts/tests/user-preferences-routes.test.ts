import { describe, expect, it, vi } from "vitest";

import {
  UserPreferencesForeignKeyViolationError,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  userPreferencesRouteAuthRequirements,
  type UserPreferencesRecord,
  type UserPreferencesRepository,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type RepositoryCall =
  | ["get", string]
  | ["put", string, Record<string, unknown>, { clearBackground: boolean }];

function createHarness(options: {
  email?: string | null;
  getRow?: UserPreferencesRecord | null;
  putRow?: UserPreferencesRecord;
  putError?: unknown;
} = {}) {
  const calls: RepositoryCall[] = [];
  const repository: UserPreferencesRepository = {
    async get(email) {
      calls.push(["get", email]);
      return options.getRow ?? null;
    },
    async put(email, prefs, writeOptions) {
      calls.push(["put", email, prefs, writeOptions]);
      if (options.putError !== undefined) throw options.putError;
      return options.putRow ?? {
        email,
        prefs,
        hasBackground: false,
        updatedAt: "2026-07-09T03:05:06+00:00",
      };
    },
  };
  const app = createApp({
    config,
    userPreferencesRoutes: {
      repository,
      resolveAuthenticatedEmail: () => (
        Object.hasOwn(options, "email") ? options.email : "User@Example.com"
      ),
    },
  });
  return { app, calls };
}

describe("user preferences route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps user preferences routes disabled on the default app", async () => {
    const app = createApp({ config });

    const get = await app.inject({ method: "GET", url: "/api/user/preferences" });
    const put = await app.inject({
      method: "PUT",
      url: "/api/user/preferences",
      payload: {},
    });

    expect(get.statusCode).toBe(404);
    expect(put.statusCode).toBe(404);

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 89-90", () => {
    expect(userPreferencesRouteAuthRequirements).toEqual({
      "GET /api/user/preferences": true,
      "PUT /api/user/preferences": true,
    });

    expect(fixtures.routeInventory.routes
      .filter((route) => route.path.startsWith("/api/user/"))
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]))
      .toEqual([
        [89, "GET", "/api/user/preferences", true],
        [90, "PUT", "/api/user/preferences", true],
        [91, "POST", "/api/user/background", true],
        [92, "GET", "/api/user/background", true],
        [93, "DELETE", "/api/user/background", true],
      ]);
  });

  it("returns Python-compatible default preferences for an authenticated user", async () => {
    const { app, calls } = createHarness();

    const response = await app.inject({ method: "GET", url: "/api/user/preferences" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      email: "user@example.com",
      preferences: {
        appearance: "system",
        wallpaper: { mode: "bokeh" },
        glass: {
          enabled: true,
          refraction: 75,
          blur: 5,
          chromatic: 0.8,
          specular: 0.25,
          tint: 0.42,
        },
      },
      appearance: "system",
      wallpaper: { mode: "bokeh" },
      hasBackground: false,
      backgroundUrl: null,
      updatedAt: null,
    });
    expect(calls).toEqual([["get", "user@example.com"]]);

    await app.close();
  });

  it("serializes stored photo wallpaper background URLs with updated timestamp", async () => {
    const { app } = createHarness({
      getRow: {
        email: "user@example.com",
        prefs: {
          appearance: "dark",
          wallpaper: {
            mode: "photo",
            customImage: "https://example.com/old.png",
          },
          glass: { enabled: false },
        },
        hasBackground: true,
        updatedAt: "2026-07-09T03:05:06+00:00",
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/user/preferences" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      email: "user@example.com",
      appearance: "dark",
      hasBackground: true,
      backgroundUrl: "/api/user/background?v=1783566306",
      updatedAt: "2026-07-09T03:05:06+00:00",
    });
    expect(response.json().wallpaper).toEqual({
      mode: "photo",
      customImage: "/api/user/background?v=1783566306",
    });

    await app.close();
  });

  it("normalizes PUT payload prefs first and lets top-level keys override", async () => {
    const { app, calls } = createHarness();

    const response = await app.inject({
      method: "PUT",
      url: "/api/user/preferences",
      payload: {
        prefs: {
          appearance: "light",
          wallpaper: { mode: "photo", customImage: "javascript:alert(1)" },
          glass: {
            enabled: "yes",
            refraction: true,
            blur: 999,
            chromatic: "2.25",
            specular: -1,
            tint: 2,
          },
        },
        appearance: "dark",
        wallpaper: { mode: "metal" },
        clearBackground: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      [
        "put",
        "user@example.com",
        {
          appearance: "dark",
          wallpaper: { mode: "metal" },
          glass: {
            enabled: true,
            refraction: 75,
            blur: 8,
            chromatic: 2.25,
            specular: 0,
            tint: 1,
          },
        },
        { clearBackground: true },
      ],
    ]);
    expect(response.json()).toMatchObject({
      appearance: "dark",
      wallpaper: { mode: "metal" },
      hasBackground: false,
    });

    await app.close();
  });

  it.each([
    [null, "Authenticated user email is required"],
    ["not-an-email", "Invalid authenticated user email"],
    ["   ", "Authenticated user email is required"],
  ])("rejects missing or invalid authenticated email %#", async (email, detail) => {
    const { app, calls } = createHarness({ email });

    const response = await app.inject({ method: "GET", url: "/api/user/preferences" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ detail });
    expect(calls).toEqual([]);

    await app.close();
  });

  it("maps foreign key write failures to the Python 403 detail", async () => {
    const { app } = createHarness({
      putError: new UserPreferencesForeignKeyViolationError("missing user"),
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/user/preferences",
      payload: { appearance: "dark" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      detail: "Authenticated user is not registered for dashboard access",
    });

    await app.close();
  });

  it("keeps user background routes out of this harness", async () => {
    const { app } = createHarness();

    for (const request of [
      { method: "POST", url: "/api/user/background" },
      { method: "GET", url: "/api/user/background" },
      { method: "DELETE", url: "/api/user/background" },
    ] as const) {
      expect(await app.inject(request)).toMatchObject({ statusCode: 404 });
    }

    await app.close();
  });

  it("propagates non-foreign-key write errors as 500", async () => {
    const { app } = createHarness({
      putError: new Error("database exploded"),
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/user/preferences",
      payload: { appearance: "dark" },
    });

    expect(response.statusCode).toBe(500);

    await app.close();
  });

  it("propagates email resolver failures as 500 without repository writes", async () => {
    const repository = {
      get: vi.fn(),
      put: vi.fn(),
    } satisfies UserPreferencesRepository;
    const app = createApp({
      config,
      userPreferencesRoutes: {
        repository,
        resolveAuthenticatedEmail: async () => {
          throw new Error("auth missing");
        },
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/user/preferences" });

    expect(response.statusCode).toBe(500);
    expect(repository.get).not.toHaveBeenCalled();
    expect(repository.put).not.toHaveBeenCalled();

    await app.close();
  });
});
