import { isIP } from "node:net";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import middie from "@fastify/middie";
import type { FastifyInstance } from "fastify";
import { errors, Provider, type Configuration } from "oidc-provider";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import { oauthAdapter } from "./oauth_adapter.js";

export const oauthScopes = ["conversations", "cards:read", "folders:read"] as const;
const scopeSet = new Set<string>(oauthScopes);
export const oauthRouteAuthRequirements = {
  "GET /.well-known/oauth-authorization-server": false,
  "GET /.well-known/oauth-protected-resource": false,
  "POST /api/oauth/register": false,
  "GET /api/oauth/authorize": false,
  "GET /api/oauth/authorize/{uid}": false,
  "GET /api/oauth/interaction/{uid}": false,
  "POST /api/oauth/interaction/{uid}": false,
  "POST /api/oauth/token": false,
  "POST /api/oauth/revoke": false,
  "GET /api/oauth/jwks": false,
} as const;

type Interaction = (provider: Provider, req: IncomingMessage, res: ServerResponse) => Promise<void>;
export type OAuthRouteOptions = {
  issuer: string;
  sql: SqlClient;
  jwks?: NonNullable<Configuration["jwks"]>;
  cookieKeys?: string[];
  interaction?: Interaction;
};

function validateClient(_ctx: unknown, _key: string, _value: unknown, metadata: Record<string, unknown>) {
  if (metadata.application_type !== "native" || metadata.token_endpoint_auth_method !== "none") {
    throw new errors.InvalidClientMetadata("only public native clients are supported");
  }
  if (!Array.isArray(metadata.redirect_uris) || !metadata.redirect_uris.length ||
      !metadata.redirect_uris.every(loopbackCallback)) {
    throw new errors.InvalidClientMetadata("redirect URIs must be loopback IP callback URLs");
  }
  if (metadata.sector_identifier_uri || metadata.jwks_uri) {
    throw new errors.InvalidClientMetadata("remote client metadata is not supported");
  }
  if (metadata.scope === undefined) metadata.scope = oauthScopes.join(" ");
  if (typeof metadata.scope !== "string" || metadata.scope.split(" ").some(scope => !scopeSet.has(scope))) {
    throw new errors.InvalidClientMetadata("unsupported scope");
  }
}
function loopbackCallback(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = (isIP(host) === 4 && host.startsWith("127.")) || host === "::1";
    return url.protocol === "http:" && loopback && url.pathname === "/callback" &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function registerOAuthRoutes(app: FastifyInstance, options: OAuthRouteOptions): void {
  let pending: Promise<Provider> | undefined;
  const getProvider = () => pending ??= createProvider(options).catch(error => {
    pending = undefined;
    throw error;
  });
  app.register(async scoped => {
    await scoped.register(middie);
    scoped.use((req, res, next) => {
      const path = (req.url ?? "").split("?", 1)[0]!;
      if (path === "/.well-known/oauth-authorization-server" ||
          path === "/api/oauth/register" || path === "/api/oauth/token" ||
          path === "/api/oauth/revoke" || path === "/api/oauth/jwks" ||
          path === "/api/oauth/authorize" || path.startsWith("/api/oauth/authorize/")) {
        void getProvider().then(provider => provider.callback()(req, res)).catch(() => {
          res.statusCode = 500; res.end("OAuth server unavailable");
        });
        return;
      }
      next();
    });
    const handled = async () => ({ detail: "OAuth handler unavailable" });
    scoped.get("/.well-known/oauth-authorization-server", handled);
    scoped.get("/.well-known/oauth-protected-resource", async () => ({ resource: options.issuer, authorization_servers: [options.issuer], scopes_supported: oauthScopes, bearer_methods_supported: ["header"] }));
    scoped.post("/api/oauth/register", handled);
    scoped.get("/api/oauth/authorize", handled);
    scoped.get("/api/oauth/authorize/:uid", handled);
    scoped.post("/api/oauth/token", handled);
    scoped.post("/api/oauth/revoke", handled);
    scoped.get("/api/oauth/jwks", handled);
    scoped.route({ method: ["GET", "POST"], url: "/api/oauth/interaction/:uid", handler: async (request, reply) => {
      if (!options.interaction) return reply.code(501).send({ detail: "OAuth interaction is not available" });
      const provider = await getProvider();
      reply.hijack();
      await options.interaction(provider, request.raw, reply.raw);
    } });
  });
}

async function createProvider(options: OAuthRouteOptions): Promise<Provider> {
  const secrets = options.jwks && options.cookieKeys
    ? { jwks: options.jwks, cookieKeys: options.cookieKeys }
    : await getOrCreateOAuthKeys(options.sql);
  const provider = new Provider(options.issuer, {
    adapter: oauthAdapter(options.sql),
    jwks: secrets.jwks,
    cookies: { keys: secrets.cookieKeys },
    scopes: oauthScopes,
    clientAuthMethods: ["none"],
    clientDefaults: { application_type: "native", token_endpoint_auth_method: "none" },
    responseTypes: ["code"],
    allowOmittingSingleRegisteredRedirectUri: false,
    pkce: { required: () => true },
    ttl: { AuthorizationCode: 300, AccessToken: 3600, RefreshToken: 30 * 24 * 60 * 60, Grant: 365 * 24 * 60 * 60 },
    rotateRefreshToken: true,
    expiresWithSession: () => false,
    issueRefreshToken: (_ctx, client) => client.applicationType === "native" && client.clientAuthMethod === "none" && client.grantTypeAllowed("refresh_token"),
    findAccount: async (_ctx, accountId) => ({ accountId, async claims() { return { sub: accountId }; } }),
    features: { devInteractions: { enabled: false }, registration: { enabled: true, issueRegistrationAccessToken: false }, revocation: { enabled: true } },
    routes: { authorization: "/api/oauth/authorize", token: "/api/oauth/token", registration: "/api/oauth/register", revocation: "/api/oauth/revoke", jwks: "/api/oauth/jwks" },
    interactions: { url: (_ctx, interaction) => `/api/oauth/interaction/${interaction.uid}` },
    extraClientMetadata: { properties: ["soulstream_policy"], validator: validateClient },
  });
  provider.proxy = true;
  // OIDC requires an internal openid scope; this server advertises only its OAuth scopes.
  provider.use(async (ctx, next) => {
    await next();
    if (ctx.path === "/.well-known/oauth-authorization-server" && ctx.status === 200 && typeof ctx.body === "object" && ctx.body !== null) {
      (ctx.body as Record<string, unknown>).scopes_supported = [...oauthScopes];
    }
  });
  return provider;
}

async function getOrCreateOAuthKeys(sql: SqlClient): Promise<{ jwks: NonNullable<Configuration["jwks"]>; cookieKeys: string[] }> {
  const rows = await sql<{ payload: { jwks: NonNullable<Configuration["jwks"]>; cookieKeys: string[] } }[]>`
    SELECT payload FROM oauth_entities WHERE kind = 'ServerKey' AND id = 'primary'
  `;
  if (rows[0]) return rows[0].payload;
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" });
  const payload = { jwks: { keys: [{ ...key, use: "sig", alg: "RS256", kid: randomBytes(16).toString("hex") }] }, cookieKeys: [randomBytes(32).toString("base64url")] };
  await sql`INSERT INTO oauth_entities (kind, id, payload) VALUES ('ServerKey', 'primary', ${sql.json(payload)}) ON CONFLICT DO NOTHING`;
  const stored = await sql<{ payload: typeof payload }[]>`SELECT payload FROM oauth_entities WHERE kind = 'ServerKey' AND id = 'primary'`;
  if (!stored[0]) throw new Error("OAuth signing keys are unavailable");
  return stored[0].payload;
}

/** S2 calls this only after authenticating and obtaining consent from the person. */
export async function finishOAuthInteraction(provider: Provider, req: IncomingMessage, res: ServerResponse, principal: string): Promise<void> {
  const details = await provider.interactionDetails(req, res);
  if (details.prompt.name === "login") {
    await provider.interactionFinished(req, res, { login: { accountId: principal } }, { mergeWithLastSubmission: false });
    return;
  }
  if (details.prompt.name !== "consent" || details.session?.accountId !== principal) throw new Error("OAuth interaction principal mismatch");
  const grant = new provider.Grant({ accountId: principal, clientId: String(details.params.client_id) });
  grant.addOIDCScope(String(details.params.scope ?? ""));
  const grantId = await grant.save();
  await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
}
