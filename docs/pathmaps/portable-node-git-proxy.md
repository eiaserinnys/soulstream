# Portable node Git read proxy

Scope: how a portable node with no GitHub credential clones and fetches the
workspace and common-files repositories through the orchestrator. The node
authenticates with its own node credential; GitHub credentials exist only in
the orchestrator process.

Entry point: `orch-server-ts/src/node_git/node_git_proxy_routes.ts`
(`registerNodeGitProxyRoutes`). Production composition passes the existing
`NodeCredentialStore` from `production.ts` and
`config.portable_node_github_read_token` through
`buildProductionRouteOptions` into `createApp`'s `nodeGitProxyRoutes` option.

## Routes and processing order

| Route | Behavior |
| --- | --- |
| `GET /api/node/git/:repo/info/refs` | Only `?service=git-upload-pack` is relayed |
| `POST /api/node/git/:repo/git-upload-pack` | Relayed with a streamed request and response body |
| `POST /api/node/git/:repo/git-receive-pack` | Always 403; push is never relayed |

Every request passes the same gates in this order:

1. Repository key must be exactly `seosoyoung_workspace` or
   `seosoyoung-common`; anything else is 404, including a write to an unknown
   key.
2. Write traffic is refused with 403: the receive-pack route itself and
   `info/refs` whose `service` query is missing or not `git-upload-pack`.
3. If `PORTABLE_NODE_GITHUB_READ_TOKEN` is empty, the answer is 503
   `PORTABLE_NODE_GIT_DISABLED`. Existing orchestrators without the value keep
   starting and serve everything else as before.
4. The request must carry HTTP Basic credentials with username
   `soulstream-node`. The password is the node token and is resolved by
   `NodeCredentialResolver.resolve` (in-memory, sync). A missing or malformed
   header, another username, a foreign token, a revoked token, or a store that
   failed to initialize all answer 401 with
   `WWW-Authenticate: Basic realm="soulstream-node-git"`. Bearer tokens are not
   accepted here and the shared service bearer path is not widened.
   `company_pc` does not change any of this: every node follows the same rule.
5. The upstream call is `${upstreamBaseUrl}/${repo}.git/...` with the same
   method and tail, `redirect: "manual"`, and a newly built
   `Authorization: Basic base64("x-access-token:" + githubReadToken)`. The node
   Authorization header never leaves the process. Only `Content-Type`,
   `Accept`, `Git-Protocol`, and `Content-Encoding` are forwarded from the
   request; `User-Agent` is `soulstream-node-git-proxy`.

The POST body is passed to `fetch` as the raw request stream
(`duplex: "half"`), so payload size does not accumulate in memory. The proxy
registers its content type parsers inside the route's own plugin scope, so no
other route gains a stream parser.

## Response and failure behavior

- Status is copied. Only `Content-Type`, `Cache-Control`, `Expires`, and
  `Pragma` are copied from the upstream response.
  `Content-Encoding` and `Content-Length` are not forwarded: `fetch`
  decompresses the body, so forwarding those headers would misdescribe the
  bytes.
- The body is streamed back with `Readable.fromWeb`. Upstream bodies and tokens
  never appear in logs or error payloads; logs carry only repo, service,
  result, and credential_id.
- Upstream non-2xx becomes 502 `{error: "UPSTREAM_REJECTED", status}`, and a
  transport failure or timeout becomes 502 `{error: "UPSTREAM_UNAVAILABLE"}`.
  Neither response repeats the upstream body or status text.
- Client disconnect (`request.raw` aborted, or the response socket closing
  before completion) aborts the upstream fetch through an `AbortController`
  combined with a 3600-second `AbortSignal.timeout`.
- No retries, rate limiting, caching, redirect following, or dumb-HTTP
  support exist in this layer.

## Revocation effect

Revocation removes the token from the in-memory resolver, so the next proxy
request answers 401. Bytes already relayed to the node before revocation
cannot be recalled; revocation stops future reads only. This is the same
credential the node uses for its other orchestrator calls, so revoking it cuts
both surfaces together.

## Files

| Item | Location |
| --- | --- |
| Proxy routes and auth requirement map | `orch-server-ts/src/node_git/node_git_proxy_routes.ts` |
| Route registration option | `orch-server-ts/src/app.ts` (`nodeGitProxyRoutes`) |
| Production composition | `orch-server-ts/src/production.ts` |
| Upstream token config | `orch-server-ts/src/config.ts` (`portable_node_github_read_token`) |
| Env reference | `orch-server-ts/.env.example` (`PORTABLE_NODE_GITHUB_READ_TOKEN`) |
| Route coverage registration | `orch-server-ts/src/contract/route_coverage_matrix.ts` |
| Tests | `orch-server-ts/tests/node-git-proxy-routes.test.ts` |
