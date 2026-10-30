import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerOAuthRoutes, finishOAuthInteraction } from "../../src/oauth/oauth_routes.js";
import { createApp } from "../../src/app.js";
import { parseOrchServerConfig } from "../../src/config.js";
import { registerDashboardServing } from "../../src/dashboard/dashboard_serving.js";
import { fileURLToPath } from "node:url";

const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const account = "director@example.test";
let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof Fastify>;
let issuer: string;

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function start() {
  app = Fastify();
  await registerOAuthRoutes(app, {
    issuer, sql,
    interaction: (provider, req, res) => finishOAuthInteraction(provider, req, res, account),
  });
  await app.listen({ host: "127.0.0.1", port: Number(new URL(issuer).port) });
}
async function register(redirect = "http://127.0.0.1:10001/callback") {
  const response = await fetch(`${issuer}/api/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  return { response, data: await response.json() as Record<string, string> };
}
async function authorize(clientId: string, redirect = "http://127.0.0.1:10002/callback") {
  const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", scope: "conversations cards:read folders:read", state: "state" });
  let target = `${issuer}/api/oauth/authorize?${params}`;
  const cookies = new Map<string, string>();
  for (let i = 0; i < 8; i++) {
    const response = await fetch(target, { redirect: "manual", headers: { cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join("; ") } });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";"); const index = pair!.indexOf("="); cookies.set(pair!.slice(0,index), pair!.slice(index+1));
    }
    const location = response.headers.get("location");
    if (!location) throw new Error(`authorization did not redirect: ${response.status}`);
    const next = new URL(location, issuer);
    if (next.origin !== issuer) {
      expect(next.searchParams.get("state")).toBe("state");
      const code = next.searchParams.get("code");
      expect(code).toBeTruthy();
      return { code: code!, redirect };
    }
    target = next.href;
  }
  throw new Error("authorization redirect limit");
}
async function exchange(fields: Record<string, string>) {
  const response = await fetch(`${issuer}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  return { response, data: await response.json() as Record<string, string | number> };
}
async function codeToken(clientId: string, code: string, redirect: string, codeVerifier = verifier) {
  return exchange({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirect, code_verifier: codeVerifier });
}
async function refresh(clientId: string, token: string) {
  return exchange({ grant_type: "refresh_token", client_id: clientId, refresh_token: token });
}

// A new agent-free socket cannot reuse a connection belonging to the stopped server.
async function freshRequest(path: string, fields?: Record<string, string>) {
  const body = fields === undefined ? undefined : new URLSearchParams(fields).toString();
  return new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
    const request = httpRequest(`${issuer}${path}`, {
      agent: false,
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/x-www-form-urlencoded" } }),
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => {
        try { resolve({ status: response.statusCode!, data: JSON.parse(text) as Record<string, unknown> }); }
        catch (error) { reject(error); }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(body);
  });
}
async function freshRefresh(clientId: string, token: string) {
  return freshRequest("/api/oauth/token", { grant_type: "refresh_token", client_id: clientId, refresh_token: token });
}

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required");
  const parsed = new URL(url); const db = parsed.pathname.slice(1).toLowerCase();
  if (!db.includes("test") || ["atom_db", "reverie", "soulstream", "serendipity"].some(name => `${parsed.hostname}/${db}`.toLowerCase().includes(name))) throw new Error("unsafe test database");
  sql = postgres(url, { max: 4, onnotice: () => {} });
  const rows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')`;
  if (rows[0]?.count !== 0) throw new Error("test database must be empty");
  await sql.unsafe(await readFile(new URL("../../../packages/db-schema/sql/migrations/137_oauth_entities.sql", import.meta.url), "utf8"));
  issuer = `http://127.0.0.1:${await freePort()}`;
  await start();
});
afterAll(async () => { await app?.close(); await sql?.end({ timeout: 2 }); });

describe("OAuth authorization server", () => {
  it("exposes both metadata documents and only the intended OAuth grants and scopes", async () => {
    const meta = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
    expect(meta.headers.get("content-type")).toContain("application/json");
    const value = await meta.json() as { issuer: string; scopes_supported: string[]; grant_types_supported: string[]; code_challenge_methods_supported: string[] };
    expect(value.issuer).toBe(issuer);
    expect(value.scopes_supported.sort()).toEqual(["cards:read", "conversations", "folders:read"]);
    expect(value.grant_types_supported.sort()).toEqual(["authorization_code", "refresh_token"]);
    expect(value.code_challenge_methods_supported).toEqual(["S256"]);
    const resource = await fetch(`${issuer}/.well-known/oauth-protected-resource`);
    expect(resource.headers.get("content-type")).toContain("application/json");
    expect(await resource.json()).toMatchObject({ resource: issuer, authorization_servers: [issuer] });
  });
  it("rejects non-loopback redirects and returns no client secret for native clients", async () => {
    for (const redirect of ["https://example.com/callback", "http://localhost:1234/callback", "http://192.0.2.1/callback"]) expect((await register(redirect)).response.status).toBe(400);
    const result = await register();
    expect(result.response.status).toBe(201);
    expect(result.data.client_id).toBeTruthy();
    expect(result.data.client_secret).toBeUndefined();
  });
  it("requires an S256 challenge", async () => {
    const { data } = await register();
    for (const method of ["plain", ""]) {
      const params = new URLSearchParams({ response_type: "code", client_id: data.client_id!, redirect_uri: "http://127.0.0.1:10001/callback", scope: "conversations", code_challenge: verifier });
      if (method) params.set("code_challenge_method", method);
      const response = await fetch(`${issuer}/api/oauth/authorize?${params}`, { redirect: "manual" });
      if (response.status < 400) expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBeTruthy();
      else expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });
  it("validates verifier and exact token redirect, issues opaque tokens, and rejects reused codes", async () => {
    const { data } = await register(); const id = data.client_id!; const auth = await authorize(id);
    expect((await codeToken(id, auth.code, auth.redirect, "x".repeat(43))).response.status).toBe(400);
    expect((await codeToken(id, auth.code, "http://127.0.0.1:10003/callback")).response.status).toBe(400);
    const token = await codeToken(id, auth.code, auth.redirect);
    expect(token.response.status).toBe(200);
    expect(token.data).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(typeof token.data.access_token).toBe("string"); expect(typeof token.data.refresh_token).toBe("string");
    expect((token.data.access_token as string).split(".")).toHaveLength(1);
    expect((await codeToken(id, auth.code, auth.redirect)).response.status).toBe(400);
  });
  it("allows only one simultaneous code exchange", async () => {
    const { data } = await register(); const id = data.client_id!; const auth = await authorize(id);
    const results = await Promise.all([codeToken(id, auth.code, auth.redirect), codeToken(id, auth.code, auth.redirect)]);
    expect(results.map(result => result.response.status).sort()).toEqual([200, 400]);
  });
  it("expires authorization codes after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = Date.now();
      const { data } = await register(); const id = data.client_id!; const auth = await authorize(id);
      vi.setSystemTime(now + 301_000);
      expect((await codeToken(id, auth.code, auth.redirect)).response.status).toBe(400);
    } finally { vi.useRealTimers(); }
  });
  it("rotates refresh without offline_access, survives restart, and rejects reuse", async () => {
    const { data } = await register(); const id = data.client_id!; const auth = await authorize(id);
    const initial = await codeToken(id, auth.code, auth.redirect);
    const first = await refresh(id, initial.data.refresh_token as string);
    expect(first.response.status).toBe(200);
    expect(first.data.refresh_token).not.toBe(initial.data.refresh_token);
    const publicKeys = await (await fetch(`${issuer}/api/oauth/jwks`)).json();
    await app.close(); await start();
    expect((await freshRequest("/api/oauth/jwks")).data).toEqual(publicKeys);
    const second = await freshRefresh(id, first.data.refresh_token as string);
    expect(second.status).toBe(200);
    expect(second.data.refresh_token).not.toBe(first.data.refresh_token);
    expect((await freshRefresh(id, first.data.refresh_token as string)).status).toBe(400);
    expect((await freshRefresh(id, second.data.refresh_token as string)).status).toBe(400);
  });
  it("revokes the associated grant", async () => {
    const { data } = await register(); const id = data.client_id!; const auth = await authorize(id);
    const token = (await codeToken(id, auth.code, auth.redirect)).data.refresh_token as string;
    const revoked = await fetch(`${issuer}/api/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: id, token, token_type_hint: "refresh_token" }) });
    expect(revoked.status).toBe(200);
    expect((await refresh(id, token)).response.status).toBe(400);
  });
  it("expires an unused refresh after 30 days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = Date.now();
      const { data } = await register(); const id = data.client_id!; const auth = await authorize(id);
      const initial = await codeToken(id, auth.code, auth.redirect);
      vi.setSystemTime(now + 31 * 86400_000);
      expect((await refresh(id, initial.data.refresh_token as string)).response.status).toBe(400);
    } finally { vi.useRealTimers(); }
  });
  it("continues rotation past 30 days and expires at the fixed 365-day grant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = Date.now();
      const { data } = await register(); const id = data.client_id!; const auth = await authorize(id);
      let token = (await codeToken(id, auth.code, auth.redirect)).data.refresh_token as string;
      for (let day = 29; day <= 348; day += 29) {
        vi.setSystemTime(now + day * 86400_000);
        const result = await refresh(id, token);
        expect(result.response.status).toBe(200);
        token = result.data.refresh_token as string;
      }
      vi.setSystemTime(now + 366 * 86400_000);
      expect((await refresh(id, token)).response.status).toBe(400);
    } finally { vi.useRealTimers(); }
  });
  it("leaves production interaction closed without an injected handler", async () => {
    const other = Fastify();
    await registerOAuthRoutes(other, { issuer, sql });
    const response = await other.inject({ method: "GET", url: "/api/oauth/interaction/missing" });
    expect(response.statusCode).toBe(501);
    expect((await other.inject({ method: "POST", url: "/api/oauth/interaction/missing" })).statusCode).toBe(501);
    await other.close();
  });
  it("serves metadata through the production guard and dashboard fallback", async () => {
    const server = createApp({
      config: parseOrchServerConfig({ environment: "test", databaseUrl: "unused", authBearerToken: "unused" }),
      productionAuth: { resolveTokenAccess: async () => ({ ok: false, statusCode: 401, detail: "Authentication required" }) },
      oauthRoutes: { issuer, sql },
    });
    await registerDashboardServing(server, { dashboardDir: fileURLToPath(new URL("../fixtures/dashboard-build", import.meta.url)) });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const addr = server.server.address() as { port: number };
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]) {
      const response = await fetch(`http://127.0.0.1:${addr.port}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
    }
    await server.close();
  });
});
