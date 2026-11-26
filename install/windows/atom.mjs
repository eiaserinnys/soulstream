// atom: build, environment file, migration, a temporary server for the API key and the seed, and the key itself.
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { atomSchemaReady } from './database.mjs';
import { fail, httpRequest, killTree, log, parseEnvFile, run, waitFor, withLogTails } from './lib.mjs';
import { ATOM_API_KEY_RE, mergeEnv } from './render_config.mjs';

export const atomUrl = (ctx) => `http://127.0.0.1:${ctx.ports.atom}`;

// The atom dashboard is a convenience: when it does not build, atom still serves its API and the installer goes on
// without DASHBOARD_DIR (atom refuses to start when that folder has no index.html).
export function buildAtom(ctx) {
  run('npm', ['--prefix', ctx.atomDir, 'ci', '--include=dev'], { env: { NODE_ENV: 'development' } });
  run('npm', ['--prefix', ctx.atomDir, 'run', 'build']);
  const dashboard = join(ctx.atomDir, 'dashboard');
  try {
    run('pnpm', ['install', '--frozen-lockfile', '--prod=false'], { cwd: dashboard });
    run('pnpm', ['run', 'build'], { cwd: dashboard });
  } catch (error) {
    return {
      dashboard: false,
      notes: [`The atom dashboard did not build (${error.message}). Atom serves its API only, and the dashboard hides its atom link; the Soulstream dashboard is not affected.`],
    };
  }
  return { dashboard: true, notes: [] };
}

export function initAtom(ctx, secrets, dashboard) {
  mergeEnv(join(ctx.atomDir, '.env'), [
    'NODE_ENV=production',
    'API_HOST=127.0.0.1',
    `API_PORT=${ctx.ports.atom}`,
    `DATABASE_URL=postgresql://soulstream:${secrets.dbPassword}@127.0.0.1:${ctx.ports.postgres}/atom`,
    `JWT_SECRET=${secrets.atomJwt}`,
    ...(dashboard ? [`DASHBOARD_DIR=${join(ctx.atomDir, 'dashboard', 'dist')}`] : []),
    `FRONTEND_URL=${atomUrl(ctx)}`,
    `DASHBOARD_ADMIN_PASSWORD=${secrets.adminPassword}`,
  ], 'NODE_ENV API_HOST API_PORT DATABASE_URL JWT_SECRET DASHBOARD_ADMIN_PASSWORD DASHBOARD_DIR FRONTEND_URL'.split(' '), ctx.platform === 'win32');
  run('npm', ['--prefix', ctx.atomDir, 'run', 'migrate']);
  if (!atomSchemaReady(ctx)) throw fail('The atom schema is not complete after the migration.');
}

// Runs fn while a plain atom server is up. The server is stopped by its PID, whatever fn does.
export async function withTemporaryAtom(ctx, fn) {
  const out = openSync(join(ctx.logsDir, 'atom-install.log'), 'a');
  const child = spawn(process.execPath, ['dist/api/index.js'], {
    cwd: ctx.atomDir,
    env: { ...process.env, ...parseEnvFile(join(ctx.atomDir, '.env')) },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  closeSync(out);
  let exited = false;
  child.on('exit', () => { exited = true; });
  try {
    await withLogTails([join(ctx.logsDir, 'atom-install.log')], () => waitFor('atom to answer /api/health', async () => {
      if (exited) throw fail('atom exited during startup.');
      return (await httpRequest(`${atomUrl(ctx)}/api/health`, { timeoutMs: 3000 })).status === 200;
    }, { timeoutMs: 60000 }));
    return await fn();
  } finally {
    killTree(child.pid);
  }
}

const outlineStatus = async (ctx, key) =>
  (await httpRequest(`${atomUrl(ctx)}/api/tree/outline`, { headers: { 'x-api-key': key }, timeoutMs: 10000 }).catch(() => ({ status: 0 }))).status;

export async function issueAtomApiKey(ctx, secrets) {
  const keyFile = join(ctx.soulDir, '.atom-api-key');
  if (existsSync(keyFile) && readFileSync(keyFile, 'utf8').trim() !== '') {
    const key = readFileSync(keyFile, 'utf8').replace(/\n$/, '');
    if (!ATOM_API_KEY_RE.test(key)) throw fail('Stored atom API key has an unexpected format.');
    const status = await outlineStatus(ctx, key);
    if (status === 200) { log('Existing atom API key accepted.'); return; }
    if (status !== 401) throw fail(`Atom API key check failed with HTTP ${status}.`);
    log('Existing atom API key was rejected; issuing a new key.');
  }
  const login = await httpRequest(`${atomUrl(ctx)}/api/auth/password-login`, { method: 'POST', body: { password: secrets.adminPassword.trim() } });
  if (login.status !== 200) throw fail(`Atom password login failed with HTTP ${login.status}.`);
  const agentId = `soulstream-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const issued = await httpRequest(`${atomUrl(ctx)}/api/config/agents`, {
    method: 'POST', headers: { Cookie: login.cookie }, body: { agent_id: agentId, display_name: 'Soulstream', scope: 'write' },
  });
  if (issued.status !== 201) throw fail(`Atom API key issuance failed with HTTP ${issued.status}.`);
  const key = issued.json?.secret;
  if (typeof key !== 'string' || !ATOM_API_KEY_RE.test(key)) throw fail('Atom API key issuance returned no usable key.');
  const temp = `${keyFile}.${process.pid}`;
  writeFileSync(temp, key, { mode: 0o600 });
  renameSync(temp, keyFile);
  if ((await outlineStatus(ctx, key)) !== 200) throw fail('New atom API key was rejected.');
  log(`Issued atom API key for ${agentId}.`);
}

// Returns the WARNING lines of the loader.
export function loadAtomInstructions(ctx) {
  const output = run(process.execPath, [
    join(ctx.soulDir, 'install', 'seed', 'load_atom_seed.mjs'),
    '--atom-url', atomUrl(ctx), '--password-file', join(ctx.soulDir, '.admin-password'), '--state-dir', join(ctx.soulDir, 'config'),
  ], { capture: true, label: 'atom seed loader' });
  if (output.trim() !== '') log(output.trimEnd());
  return output.split('\n').filter((line) => line.startsWith('WARNING: ')).map((line) => line.slice('WARNING: '.length));
}
