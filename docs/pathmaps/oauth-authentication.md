# OAuth login and resource authentication

## Person login and consent

1. A native client discovers `/.well-known/oauth-authorization-server` and
   `/.well-known/oauth-protected-resource`, then registers a public client at
   `POST /api/oauth/register`. `orch-server-ts/src/oauth/oauth_routes.ts`
   validates loopback callback URIs, PKCE, client metadata, and supported scopes.
2. The client opens `GET /api/oauth/authorize`. `oidc-provider` records the
   authorization request and sends the browser to
   `GET /api/oauth/interaction/{uid}`.
3. If the dashboard JWT cookie is missing or invalid, the interaction redirects
   to the existing `GET /api/auth/google?return_to=...`. Google returns to
   `GET /api/auth/google/callback`, which validates the Google identity against
   `ALLOWED_EMAIL`, issues the dashboard JWT cookie, and redirects back to the
   relative interaction path.
4. The interaction verifies the cookie and checks `ALLOWED_EMAIL` again. A
   login prompt is completed with the verified account email. A consent prompt
   reads the registered client name and requested scopes from OAuth storage and
   redirects to the dashboard SPA route `/oauth/consent`.
5. The SPA reads the consent view from `GET /api/oauth/interaction/{uid}`. The
   server sets an HttpOnly CSRF cookie and returns its matching token in the
   response body. The allow/cancel form posts both to the same interaction
   route. The server verifies the dashboard cookie and CSRF pair again. Allow
   creates the grant; cancel completes the interaction with `access_denied`.
6. The client receives an authorization code at its loopback callback and
   exchanges it with the PKCE verifier at `POST /api/oauth/token`. Opaque
   access and rotating refresh tokens are stored through the same OAuth adapter
   used by `oidc-provider`.

The return path contains only the local interaction path and its opaque UID. The
authorization code, verifier, and tokens stay out of it and out of route logs.

## Bearer scope and folder ACL

`orch-server-ts/src/oauth/oauth_access.ts` resolves the opaque access token and
client from OAuth storage and rechecks the current `ALLOWED_EMAIL` policy. The
production auth guard checks the matching scope before route execution:

| Request | Required scope |
| --- | --- |
| `GET /api/cards` and read subroutes | `cards:read` |
| `GET /api/folders` and read subroutes | `folders:read` |
| every other protected route | rejected for OAuth credentials |

The existing `live_dashboard_access_provider.ts` resolves the same verified
email through the dashboard users repository. Card and folder handlers then
apply that account's stored folder ACL. `conversations` has a shared checker,
`requireOAuthScope`, for a later conversation API; S2 attaches it to no route.

## Caller identity

`live_authenticated_user_resolver.ts` treats a verified OAuth bearer as a
browser caller and supplies server-owned `transport: "oauth"`,
`oauth_client_id`, and `oauth_client_name`. The interaction stores the verified
Google account's email, display name, and picture in OAuth storage; the token
resolver uses those fields for `caller_info`. Request-body `caller_info` cannot
replace them.
