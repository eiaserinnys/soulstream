import { Buffer } from "node:buffer";

import type { FastifyInstance, FastifyReply } from "fastify";

import { parseMultipartForm, registerMultipartFormParser } from "../http/multipart_form.js";
import {
  normalizeUserPreferences,
  requestUserPreferencesEmail,
  serializePreferences,
  userPreferencesWriteError,
  type NormalizedUserPreferences,
  type UserPreferencesEmailResolver,
  type UserPreferencesRecord,
  type UserPreferencesRepository,
} from "./user_preferences_routes.js";

export const ALLOWED_BACKGROUND_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export const MAX_BACKGROUND_BYTES = 5 * 1024 * 1024;

export type UserBackgroundMimeType = typeof ALLOWED_BACKGROUND_MIME_TYPES[number];

export type UserBackgroundRepository = UserPreferencesRepository & {
  putBackground: (
    email: string,
    prefs: NormalizedUserPreferences,
    input: { blob: Buffer; mime: UserBackgroundMimeType },
  ) => Promise<UserPreferencesRecord> | UserPreferencesRecord;
};

export type UserBackgroundRouteOptions = {
  repository: UserBackgroundRepository;
  resolveAuthenticatedEmail: UserPreferencesEmailResolver;
};

type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; statusCode: number; body: unknown };

const ALLOWED_BACKGROUND_MIME_TYPE_SET = new Set<string>(ALLOWED_BACKGROUND_MIME_TYPES);

export const userBackgroundRouteAuthRequirements = {
  "POST /api/user/background": true,
  "GET /api/user/background": true,
  "DELETE /api/user/background": true,
} as const;

export function registerUserBackgroundRoutes(
  app: FastifyInstance,
  options: UserBackgroundRouteOptions,
): void {
  registerMultipartFormParser(app);

  app.post("/api/user/background", async (request, reply) => {
    const email = await requestUserPreferencesEmail(options, request);
    if (!email.ok) return routeError(reply, email.error.statusCode, { detail: email.error.message });

    const form = parseMultipartForm(request);
    if (!form.ok) {
      return routeError(reply, form.statusCode ?? 400, { detail: form.message });
    }
    const mime = validateBackgroundMime(form.value.file.contentType);
    if (!mime.ok) return routeError(reply, mime.statusCode, mime.body);
    const blob = validateBackgroundBlob(form.value.file.content);
    if (!blob.ok) return routeError(reply, blob.statusCode, blob.body);

    const existing = await options.repository.get(email.value);
    const prefs = normalizeUserPreferences(existing?.prefs);
    prefs.wallpaper = {
      mode: "photo",
      customImage: "/api/user/background",
    };

    try {
      const row = await options.repository.putBackground(email.value, prefs, {
        blob: blob.value,
        mime: mime.value,
      });
      return serializePreferences(row);
    } catch (error) {
      return userPreferencesWriteError(reply, error);
    }
  });

  app.get("/api/user/background", async (request, reply) => {
    const email = await requestUserPreferencesEmail(options, request);
    if (!email.ok) return routeError(reply, email.error.statusCode, { detail: email.error.message });

    const row = await options.repository.get(email.value);
    const background = row === null ? null : backgroundPayload(row);
    if (background === null) {
      return reply.code(404).send({ detail: "No background image is stored" });
    }
    return reply.type(background.mime).send(background.blob);
  });

  app.delete("/api/user/background", async (request, reply) => {
    const email = await requestUserPreferencesEmail(options, request);
    if (!email.ok) return routeError(reply, email.error.statusCode, { detail: email.error.message });

    const existing = await options.repository.get(email.value);
    const prefs = normalizeUserPreferences(existing?.prefs);
    prefs.wallpaper = { mode: "bokeh" };
    try {
      const row = await options.repository.put(email.value, prefs, {
        clearBackground: true,
      });
      return serializePreferences(row);
    } catch (error) {
      return userPreferencesWriteError(reply, error);
    }
  });
}

function validateBackgroundMime(value: string): Validation<UserBackgroundMimeType> {
  const mime = normalizeBackgroundMime(value);
  if (mime === null) {
    return {
      ok: false,
      statusCode: 415,
      body: {
        detail: {
          error: "UNSUPPORTED_BACKGROUND_MIME",
          allowed: ALLOWED_BACKGROUND_MIME_TYPES,
        },
      },
    };
  }
  return { ok: true, value: mime };
}

export function normalizeBackgroundMime(value: string | null | undefined): UserBackgroundMimeType | null {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === undefined || !ALLOWED_BACKGROUND_MIME_TYPE_SET.has(mime)) return null;
  return mime as UserBackgroundMimeType;
}

function validateBackgroundBlob(value: Buffer): Validation<Buffer> {
  if (value.length > MAX_BACKGROUND_BYTES) {
    return {
      ok: false,
      statusCode: 413,
      body: {
        detail: {
          error: "BACKGROUND_TOO_LARGE",
          maxBytes: MAX_BACKGROUND_BYTES,
        },
      },
    };
  }
  if (value.length === 0) {
    return {
      ok: false,
      statusCode: 400,
      body: { detail: "Background image is empty" },
    };
  }
  return { ok: true, value: Buffer.from(value) };
}

function backgroundPayload(row: UserPreferencesRecord): { blob: Buffer; mime: UserBackgroundMimeType } | null {
  const blob = backgroundBlob(row.backgroundBlob ?? row.background_blob);
  const mime = backgroundMime(row.backgroundMime ?? row.background_mime);
  if (blob === null || mime === null) return null;
  return { blob, mime };
}

function backgroundBlob(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

function backgroundMime(value: unknown): UserBackgroundMimeType | null {
  return typeof value === "string" ? normalizeBackgroundMime(value) : null;
}

function routeError(reply: FastifyReply, statusCode: number, body: unknown): FastifyReply {
  return reply.code(statusCode).send(body);
}
