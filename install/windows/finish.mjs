// After the services are up: wait for them, create the default workspace folder, refresh the model presets.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, httpRequest, log, readEnvValue, sleep, waitFor, withLogTails } from './lib.mjs';

const WORKSPACE_FOLDER = '작업실';

export const orchUrl = (ctx) => `http://127.0.0.1:${ctx.ports.orch}`;

async function adminSession(ctx) {
  const password = readFileSync(join(ctx.soulDir, '.admin-password'), 'utf8').replace(/\r?\n$/, '');
  const login = await httpRequest(`${orchUrl(ctx)}/api/auth/password-login`, { method: 'POST', body: { password } });
  if (login.status !== 200) throw fail(`Soulstream administrator login failed with HTTP ${login.status}.`);
  return { Cookie: login.cookie };
}

const folderCount = async (ctx, headers) => {
  const response = await httpRequest(`${orchUrl(ctx)}/api/folders`, { headers });
  return (response.json?.folders ?? []).filter((folder) => folder.name === WORKSPACE_FOLDER).length;
};

export async function waitAndCreateWorkspace(ctx) {
  const bearer = { Authorization: `Bearer ${readEnvValue(join(ctx.soulDir, '.env.orch'), 'AUTH_BEARER_TOKEN')}` };
  const serviceLogs = ['haniel.err.log', 'haniel.log', 'atom.log', 'orch.log', 'worker.log'].map((name) => join(ctx.logsDir, name));
  await withLogTails(serviceLogs, () => waitFor('Soulstream, the worker and the local node', async () => {
    if ((await httpRequest(`${orchUrl(ctx)}/api/health`, { timeoutMs: 3000 })).status !== 200) return false;
    if ((await httpRequest(`http://127.0.0.1:${ctx.ports.worker}/health`, { timeoutMs: 3000 })).status !== 200) return false;
    const nodes = await httpRequest(`${orchUrl(ctx)}/api/nodes`, { headers: bearer, timeoutMs: 3000 });
    return (nodes.json?.nodes ?? []).some((node) => node.nodeId === 'local' && node.connected === true);
  }, { timeoutMs: 180000 }));
  const session = await adminSession(ctx);
  if ((await folderCount(ctx, session)) === 0) {
    const created = await httpRequest(`${orchUrl(ctx)}/api/folders`, {
      method: 'POST', headers: session, body: { name: WORKSPACE_FOLDER, idempotencyKey: 'clean-install-default-workspace' },
    });
    if (created.status >= 300) throw fail(`Creating the workspace folder failed with HTTP ${created.status}.`);
  }
  if ((await folderCount(ctx, session)) !== 1) throw fail('The workspace folder was not created exactly once.');
  const anonymous = await httpRequest(`${orchUrl(ctx)}/api/folders`);
  if (anonymous.status !== 401) throw fail(`An unauthenticated request to /api/folders answered HTTP ${anonymous.status}, expected 401.`);
}

const PROVIDERS = ['claude', 'codex', 'antigravity', 'opencode_go'];

// confirmed: the local node and every provider answered with a fresh status.
function presetsConfirmed(response) {
  const node = (response?.nodes ?? []).find((n) => n.nodeId === 'local');
  if (!node || node.stale !== false) return false;
  return PROVIDERS.every((name) => {
    const provider = node.providers?.[name];
    return provider && (provider.status === 'auto' || provider.status === 'not_configured') && provider.stale === false;
  });
}

// Never fails the install: the presets also refresh by themselves within five minutes.
export async function refreshModelPresets(ctx) {
  const headers = { Authorization: `Bearer ${readEnvValue(join(ctx.soulDir, '.env.orch'), 'AUTH_BEARER_TOKEN')}` };
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await httpRequest(`${orchUrl(ctx)}/api/usage/refresh`, { method: 'POST', headers, timeoutMs: 60000 }).catch(() => null);
    const confirmed = response?.status === 200 && presetsConfirmed(response.json);
    log(`Preset refresh attempt ${attempt}: ${confirmed ? 'confirmed' : 'pending'}`);
    if (confirmed) return true;
    if (attempt < 6) await sleep(10000);
  }
  return false;
}
