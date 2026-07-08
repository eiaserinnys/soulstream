import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ALLOWED_APPEARANCES = new Set(["system", "light", "dark"]);
const ALLOWED_WALLPAPER_MODES = new Set(["bokeh", "metal", "photo", "plain"]);

const DEFAULT_GLASS_SETTINGS = {
  enabled: true,
  refraction: 75,
  blur: 5,
  chromatic: 0.8,
  specular: 0.25,
  tint: 0.42,
} as const;

const GLASS_NUMERIC_LIMITS = {
  refraction: [0, 90],
  blur: [0, 8],
  chromatic: [0, 2.5],
  specular: [0, 1.5],
  tint: [0, 1],
} as const;

export type NormalizedUserPreferences = {
  appearance: "system" | "light" | "dark";
  wallpaper: {
    mode: "bokeh" | "metal" | "photo" | "plain";
    customImage?: string;
  };
  glass: {
    enabled: boolean;
    refraction: number;
    blur: number;
    chromatic: number;
    specular: number;
    tint: number;
  };
};

export type UserPreferencesRecord = {
  email: string;
  prefs?: unknown;
  hasBackground?: unknown;
  has_background?: unknown;
  backgroundBlob?: unknown;
  background_blob?: unknown;
  backgroundMime?: unknown;
  background_mime?: unknown;
  updatedAt?: unknown;
  updated_at?: unknown;
};

export type UserPreferencesRepository = {
  get: (email: string) => Promise<UserPreferencesRecord | null> | UserPreferencesRecord | null;
  put: (
    email: string,
    prefs: NormalizedUserPreferences,
    options: { clearBackground: boolean },
  ) => Promise<UserPreferencesRecord> | UserPreferencesRecord;
};

export type UserPreferencesEmailResolver = (
  request: FastifyRequest,
) => Promise<string | null | undefined> | string | null | undefined;

export type UserPreferencesRouteOptions = {
  repository: UserPreferencesRepository;
  resolveAuthenticatedEmail: UserPreferencesEmailResolver;
};

export class UserPreferencesForeignKeyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForeignKeyViolationError";
  }
}

export class UserPreferencesRouteError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "UserPreferencesRouteError";
    this.statusCode = statusCode;
  }
}

export const userPreferencesRouteAuthRequirements = {
  "GET /api/user/preferences": true,
  "PUT /api/user/preferences": true,
} as const;

export function registerUserPreferencesRoutes(
  app: FastifyInstance,
  options: UserPreferencesRouteOptions,
): void {
  app.get("/api/user/preferences", async (request, reply) => {
    const email = await requestUserPreferencesEmail(options, request);
    if (!email.ok) return userPreferencesError(reply, email.error);

    const row = await options.repository.get(email.value);
    return serializePreferences(row ?? defaultPreferences(email.value));
  });

  app.put("/api/user/preferences", async (request, reply) => {
    const email = await requestUserPreferencesEmail(options, request);
    if (!email.ok) return userPreferencesError(reply, email.error);

    const payload = isPlainObject(request.body) ? request.body : {};
    const prefs = preferencesFromPayload(payload);
    try {
      const row = await options.repository.put(email.value, prefs, {
        clearBackground: Boolean(payload.clearBackground),
      });
      return serializePreferences(row);
    } catch (error) {
      return userPreferencesWriteError(reply, error);
    }
  });
}

export async function requestUserPreferencesEmail(
  options: UserPreferencesRouteOptions,
  request: FastifyRequest,
): Promise<{ ok: true; value: string } | { ok: false; error: UserPreferencesRouteError }> {
  const rawEmail = await options.resolveAuthenticatedEmail(request);
  if (typeof rawEmail !== "string" || rawEmail.trim() === "") {
    return {
      ok: false,
      error: new UserPreferencesRouteError("Authenticated user email is required", 401),
    };
  }
  const email = normalizeEmail(rawEmail);
  if (!EMAIL_RE.test(email)) {
    return {
      ok: false,
      error: new UserPreferencesRouteError("Invalid authenticated user email", 401),
    };
  }
  return { ok: true, value: email };
}

export function serializePreferences(row: UserPreferencesRecord): Record<string, unknown> {
  const prefs = normalizeUserPreferences(row.prefs);
  const updatedAt = updatedAtValue(row);
  let backgroundUrl: string | null = null;
  if (hasBackground(row)) {
    backgroundUrl = "/api/user/background";
    const timestamp = timestampSeconds(updatedAt);
    if (timestamp !== null) {
      backgroundUrl = `${backgroundUrl}?v=${timestamp}`;
    }
    if (prefs.wallpaper.mode === "photo") {
      prefs.wallpaper = {
        ...prefs.wallpaper,
        customImage: backgroundUrl,
      };
    }
  }

  return {
    email: normalizeEmail(row.email),
    preferences: prefs,
    appearance: prefs.appearance,
    wallpaper: prefs.wallpaper,
    hasBackground: hasBackground(row),
    backgroundUrl,
    updatedAt: serializeUpdatedAt(updatedAt),
  };
}

export function normalizeUserPreferences(value: unknown): NormalizedUserPreferences {
  const source = isPlainObject(value) ? value : {};
  const rawAppearance = source.appearance;
  const appearance = ALLOWED_APPEARANCES.has(String(rawAppearance))
    ? String(rawAppearance) as NormalizedUserPreferences["appearance"]
    : "system";

  const wallpaperSource = isPlainObject(source.wallpaper) ? source.wallpaper : {};
  const rawMode = wallpaperSource.mode;
  const mode = ALLOWED_WALLPAPER_MODES.has(String(rawMode))
    ? String(rawMode) as NormalizedUserPreferences["wallpaper"]["mode"]
    : "bokeh";
  const wallpaper: NormalizedUserPreferences["wallpaper"] = { mode };
  if (
    typeof wallpaperSource.customImage === "string" &&
    isSafeBackgroundUrl(wallpaperSource.customImage)
  ) {
    wallpaper.customImage = wallpaperSource.customImage;
  }

  return {
    appearance,
    wallpaper,
    glass: normalizeGlassSettings(source.glass),
  };
}

export function preferencesFromPayload(payload: Record<string, unknown>): NormalizedUserPreferences {
  const prefs: Record<string, unknown> = {};
  if (isPlainObject(payload.prefs)) {
    Object.assign(prefs, payload.prefs);
  }
  for (const key of ["appearance", "wallpaper", "glass"] as const) {
    if (Object.hasOwn(payload, key)) {
      prefs[key] = payload[key];
    }
  }
  return normalizeUserPreferences(prefs);
}

function normalizeGlassSettings(value: unknown): NormalizedUserPreferences["glass"] {
  const source = isPlainObject(value) ? value : {};
  const normalized: NormalizedUserPreferences["glass"] = { ...DEFAULT_GLASS_SETTINGS };
  if (typeof source.enabled === "boolean") {
    normalized.enabled = source.enabled;
  }
  for (const [key, [minimum, maximum]] of Object.entries(GLASS_NUMERIC_LIMITS)) {
    const numericKey = key as keyof typeof GLASS_NUMERIC_LIMITS;
    normalized[numericKey] = numberInRange(
      source[key],
      minimum,
      maximum,
      DEFAULT_GLASS_SETTINGS[numericKey],
    );
  }
  return normalized;
}

function numberInRange(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value === "boolean") return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
}

function defaultPreferences(email: string): UserPreferencesRecord {
  return {
    email,
    prefs: normalizeUserPreferences(null),
    hasBackground: false,
    updatedAt: null,
  };
}

function hasBackground(row: UserPreferencesRecord): boolean {
  if (typeof row.hasBackground === "boolean") return row.hasBackground;
  if (typeof row.has_background === "boolean") return row.has_background;
  return Boolean(
    (row.backgroundBlob ?? row.background_blob) &&
    (row.backgroundMime ?? row.background_mime),
  );
}

function updatedAtValue(row: UserPreferencesRecord): unknown {
  return row.updatedAt ?? row.updated_at ?? null;
}

function timestampSeconds(value: unknown): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
  }
  return null;
}

function serializeUpdatedAt(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

export function userPreferencesWriteError(reply: FastifyReply, error: unknown): FastifyReply {
  if (errorName(error) === "ForeignKeyViolationError") {
    return reply.code(403).send({
      detail: "Authenticated user is not registered for dashboard access",
    });
  }
  throw error;
}

function userPreferencesError(reply: FastifyReply, error: UserPreferencesRouteError): FastifyReply {
  return reply.code(error.statusCode).send({ detail: error.message });
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isSafeBackgroundUrl(value: string): boolean {
  return (
    value.startsWith("/api/user/background") ||
    value.startsWith("data:image/") ||
    value.startsWith("https://") ||
    value.startsWith("http://")
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
