import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitAndCreateWorkspace } from '../windows/finish.mjs';

const COOKIE = 'soul_dashboard_auth=fake-finish-session';

async function startFakeOrch({ jobStatus = 201 } = {}) {
  const requests = [];
  const folders = [];
  const jobs = new Map();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const path = new URL(req.url, 'http://fake').pathname;
    requests.push({ method: req.method, path, body });
    const send = (status, payload, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(payload)); };
    if (req.method === 'GET' && (path === '/api/health' || path === '/health')) return send(200, { ok: true });
    if (req.method === 'GET' && path === '/api/nodes') return send(200, { nodes: [{ nodeId: 'local', connected: true }] });
    if (req.method === 'POST' && path === '/api/auth/password-login') return send(200, { ok: true }, { 'set-cookie': `${COOKIE}; Path=/; HttpOnly` });
    if (req.headers.cookie !== COOKIE) return send(401, {});
    if (path === '/api/folders') {
      if (req.method === 'POST') { folders.push({ id: 'folder-work-1', name: '작업실' }); return send(201, {}); }
      return send(200, { folders });
    }
    if (path === '/api/recurring-jobs' && req.method === 'POST') {
      if (jobStatus >= 300) return send(jobStatus, {});
      const job = JSON.parse(body);
      if (!jobs.has(job.idempotencyKey)) jobs.set(job.idempotencyKey, job);
      return send(jobStatus, { job: jobs.get(job.idempotencyKey) });
    }
    return send(404, {});
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return { port: server.address().port, requests, jobs, close: () => new Promise((resolvePromise) => server.close(resolvePromise)) };
}

function context(dir, port) {
  const soulDir = join(dir, 'soulstream');
  mkdirSync(soulDir, { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(soulDir, '.admin-password'), 'adminpass1\n');
  writeFileSync(join(soulDir, '.env.orch'), 'AUTH_BEARER_TOKEN=bearer\n');
  return { soulDir, logsDir: join(dir, 'logs'), ports: { orch: port, worker: port } };
}

test('finish creates the workspace folder and registers the paused daily review job once per key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'windows-finish-'));
  const orch = await startFakeOrch();
  try {
    const ctx = context(dir, orch.port);
    await waitAndCreateWorkspace(ctx);
    await waitAndCreateWorkspace(ctx);
    const posts = orch.requests.filter((request) => request.method === 'POST' && request.path === '/api/recurring-jobs');
    assert.equal(posts.length, 2);
    const job = JSON.parse(posts[0].body);
    assert.equal(job.idempotencyKey, 'clean-install-daily-review');
    assert.equal(job.enabled, false);
    assert.equal(job.agentId, 'seosoyoung');
    assert.equal(job.nodeId, 'local');
    assert.equal(job.folderId, 'folder-work-1');
    assert.equal(job.modelPreset, null);
    assert.deepEqual(job.scheduleExpressions, ['0 9 * * *']);
    assert.equal(orch.jobs.size, 1);
  } finally { await orch.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('finish keeps going when the server refuses the daily review job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'windows-finish-'));
  const orch = await startFakeOrch({ jobStatus: 422 });
  try {
    await waitAndCreateWorkspace(context(dir, orch.port));
    assert.equal(orch.jobs.size, 0);
  } finally { await orch.close(); rmSync(dir, { recursive: true, force: true }); }
});
