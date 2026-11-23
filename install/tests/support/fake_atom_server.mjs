// Fake atom HTTP server for installer tests. Listens on 127.0.0.1 with an
// ephemeral port and implements only the routes the installer calls:
//   GET  /api/tree/outline       x-api-key -> status from `keys` (401 when unknown)
//   POST /api/auth/password-login {"password"} -> 200 and a session cookie
//   POST /api/config/agents       cookie -> 201 with `secret`
// Each request is recorded as { method, path, apiKey, cookie, body }.

import { createServer } from 'node:http';

const SESSION_COOKIE = 'atom_token=fake-session';

export async function startFakeAtom({ keys = {}, password, secret }) {
  const state = { keys: { ...keys }, password, secret };
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const path = new URL(req.url, 'http://fake').pathname;
    requests.push({ method: req.method, path, apiKey: req.headers['x-api-key'] ?? null, cookie: req.headers.cookie ?? null, body });
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'GET' && path === '/api/tree/outline') {
      const status = state.keys[req.headers['x-api-key']] ?? 401;
      return send(status, status === 200 ? [] : { error: 'Unauthorized' });
    }
    if (req.method === 'POST' && path === '/api/auth/password-login') {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return send(400, { error: 'Invalid request' }); }
      if (parsed.password !== state.password) return send(401, { error: 'Invalid password' });
      return send(200, { ok: true }, { 'set-cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` });
    }
    if (req.method === 'POST' && path === '/api/config/agents') {
      if (req.headers.cookie !== SESSION_COOKIE) return send(401, { error: 'Unauthorized' });
      const parsed = JSON.parse(body);
      state.keys[state.secret] = 200;
      return send(201, { id: 'agent-1', agent_id: parsed.agent_id, display_name: parsed.display_name, scope: parsed.scope, secret: state.secret });
    }
    return send(404, { error: 'Not Found' });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}
