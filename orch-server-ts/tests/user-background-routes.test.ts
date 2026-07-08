import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  ALLOWED_BACKGROUND_MIME_TYPES,
  MAX_BACKGROUND_BYTES,
  UserPreferencesForeignKeyViolationError,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  userBackgroundRouteAuthRequirements,
  type UserBackgroundRepository,
  type UserPreferencesRecord,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type RepositoryCall =
  | ["get", string]
  | ["put", string, Record<string, unknown>, { clearBackground: boolean }]
  | ["putBackground", string, Record<string, unknown>, { blob: string; mime: string }];

function createHarness(options: {
  email?: string | null;
  getRow?: UserPreferencesRecord | null;
  putRow?: UserPreferencesRecord;
  putBackgroundRow?: UserPreferencesRecord;
  putError?: unknown;
  putBackgroundError?: unknown;
} = {}) {
  const calls: RepositoryCall[] = [];
  const repository: UserBackgroundRepository = {
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
    async putBackground(email, prefs, input) {
      calls.push([
        "putBackground",
        email,
        prefs,
        { blob: input.blob.toString("utf8"), mime: input.mime },
      ]);
      if (options.putBackgroundError !== undefined) throw options.putBackgroundError;
      return options.putBackgroundRow ?? {
        email,
        prefs,
        backgroundBlob: input.blob,
        backgroundMime: input.mime,
        updatedAt: "2026-07-09T03:05:06+00:00",
      };
    },
  };
  const app = createApp({
    config,
    userBackgroundRoutes: {
      repository,
      resolveAuthenticatedEmail: () => (
        Object.hasOwn(options, "email") ? options.email : "User@Example.com"
      ),
    },
  });
  return { app, calls };
}

function createUploadBody(options: {
  filename?: string;
  contentType?: string | null;
  content?: Buffer;
} = {}) {
  const boundary = "----soulstream-background-test";
  const chunks: Buffer[] = [];
  const append = (value: string | Buffer) => {
    chunks.push(typeof value === "string" ? Buffer.from(value, "utf8") : value);
  };
  append(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${options.filename ?? "background.png"}"\r\n`,
  );
  const contentType = options.contentType === undefined ? "image/png" : options.contentType;
  if (contentType !== null) {
    append(`Content-Type: ${contentType}\r\n`);
  }
  append("\r\n");
  append(options.content ?? Buffer.from("PNG bytes"));
  append(`\r\n--${boundary}--\r\n`);
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}

describe("user background route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps user background routes disabled on the default app", async () => {
    const app = createApp({ config });
    const upload = createUploadBody();

    for (const request of [
      { method: "POST", url: "/api/user/background", ...upload },
      { method: "GET", url: "/api/user/background" },
      { method: "DELETE", url: "/api/user/background" },
    ] as const) {
      expect(await app.inject(request)).toMatchObject({ statusCode: 404 });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 91-93", () => {
    expect(userBackgroundRouteAuthRequirements).toEqual({
      "POST /api/user/background": true,
      "GET /api/user/background": true,
      "DELETE /api/user/background": true,
    });

    expect(fixtures.routeInventory.routes
      .filter((route) => route.path === "/api/user/background")
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]))
      .toEqual([
        [91, "POST", "/api/user/background", true],
        [92, "GET", "/api/user/background", true],
        [93, "DELETE", "/api/user/background", true],
      ]);
  });

  it("uploads an allowed multipart background and serializes photo preferences", async () => {
    const { app, calls } = createHarness({
      getRow: {
        email: "user@example.com",
        prefs: {
          appearance: "dark",
          wallpaper: { mode: "metal" },
          glass: { enabled: false },
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/user/background",
      ...createUploadBody({
        contentType: "image/png; charset=binary",
        content: Buffer.from("PNG bytes"),
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ["get", "user@example.com"],
      [
        "putBackground",
        "user@example.com",
        {
          appearance: "dark",
          wallpaper: {
            mode: "photo",
            customImage: "/api/user/background",
          },
          glass: {
            enabled: false,
            refraction: 75,
            blur: 5,
            chromatic: 0.8,
            specular: 0.25,
            tint: 0.42,
          },
        },
        { blob: "PNG bytes", mime: "image/png" },
      ],
    ]);
    expect(response.json()).toMatchObject({
      email: "user@example.com",
      appearance: "dark",
      hasBackground: true,
      backgroundUrl: "/api/user/background?v=1783566306",
      wallpaper: {
        mode: "photo",
        customImage: "/api/user/background?v=1783566306",
      },
    });

    await app.close();
  });

  it.each([
    ["text/plain", "explicit unsupported"],
    [null, "missing content type"],
  ])("rejects unsupported background MIME: %s (%s)", async (contentType, _label) => {
    const { app, calls } = createHarness();

    const response = await app.inject({
      method: "POST",
      url: "/api/user/background",
      ...createUploadBody({ contentType }),
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({
      detail: {
        error: "UNSUPPORTED_BACKGROUND_MIME",
        allowed: ALLOWED_BACKGROUND_MIME_TYPES,
      },
    });
    expect(calls).toEqual([]);

    await app.close();
  });

  it("rejects too-large and empty background uploads", async () => {
    const { app, calls } = createHarness();

    const tooLarge = await app.inject({
      method: "POST",
      url: "/api/user/background",
      ...createUploadBody({ content: Buffer.alloc(MAX_BACKGROUND_BYTES + 1) }),
    });
    const empty = await app.inject({
      method: "POST",
      url: "/api/user/background",
      ...createUploadBody({ content: Buffer.alloc(0) }),
    });

    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toEqual({
      detail: { error: "BACKGROUND_TOO_LARGE", maxBytes: MAX_BACKGROUND_BYTES },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ detail: "Background image is empty" });
    expect(calls).toEqual([]);

    await app.close();
  });

  it("returns a stored background as raw binary with its stored MIME", async () => {
    const { app, calls } = createHarness({
      getRow: {
        email: "user@example.com",
        backgroundBlob: Buffer.from("WEBP bytes"),
        backgroundMime: "image/webp",
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/user/background" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(Buffer.from(response.rawPayload).toString("utf8")).toBe("WEBP bytes");
    expect(calls).toEqual([["get", "user@example.com"]]);

    await app.close();
  });

  it("returns 404 when no background is stored", async () => {
    const { app, calls } = createHarness({
      getRow: {
        email: "user@example.com",
        backgroundBlob: null,
        backgroundMime: null,
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/user/background" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ detail: "No background image is stored" });
    expect(calls).toEqual([["get", "user@example.com"]]);

    await app.close();
  });

  it("deletes a stored background and resets wallpaper to bokeh", async () => {
    const { app, calls } = createHarness({
      getRow: {
        email: "user@example.com",
        prefs: {
          appearance: "light",
          wallpaper: { mode: "photo", customImage: "/api/user/background" },
        },
        backgroundBlob: Buffer.from("PNG bytes"),
        backgroundMime: "image/png",
      },
    });

    const response = await app.inject({ method: "DELETE", url: "/api/user/background" });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ["get", "user@example.com"],
      [
        "put",
        "user@example.com",
        {
          appearance: "light",
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
        { clearBackground: true },
      ],
    ]);
    expect(response.json()).toMatchObject({
      appearance: "light",
      wallpaper: { mode: "bokeh" },
      hasBackground: false,
    });

    await app.close();
  });

  it("uses the same email and write-error contract as user preferences routes", async () => {
    const invalidEmail = createHarness({ email: "not-an-email" });
    const rejectedWrite = createHarness({
      putBackgroundError: new UserPreferencesForeignKeyViolationError("missing user"),
    });

    const invalid = await invalidEmail.app.inject({
      method: "GET",
      url: "/api/user/background",
    });
    const write = await rejectedWrite.app.inject({
      method: "POST",
      url: "/api/user/background",
      ...createUploadBody(),
    });

    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toEqual({ detail: "Invalid authenticated user email" });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toEqual({
      detail: "Authenticated user is not registered for dashboard access",
    });

    await invalidEmail.app.close();
    await rejectedWrite.app.close();
  });
});
