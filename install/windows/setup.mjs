#!/usr/bin/env node
// The Node half of install-windows.ps1. Steps and order follow install.sh; PowerShell calls this between its own steps.
//   prepare        secrets, databases, atom, API key, seed, configuration, builds, schema
//   haniel-config  writes haniel.yaml
//   finish         waits for the services, creates the workspace folder, refreshes presets, prints the summary
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readInstallerText } from '../seed/locales/installer-text.mjs';
import { buildAtom, initAtom, issueAtomApiKey, loadAtomInstructions, withTemporaryAtom } from './atom.mjs';
import { installationLanguage, requireClis } from './cli.mjs';
import { prepareSecrets, setupDatabases, setupSchema } from './database.mjs';
import { orchUrl, refreshModelPresets, waitAndCreateWorkspace } from './finish.mjs';
import { renderHanielConfig } from './haniel_config.mjs';
import { fail, log, originOption, parseArgs, readEnvValue, run } from './lib.mjs';
import { renderConfig } from './render_config.mjs';

const BACKENDS = ['claude', 'codex'];

function buildContext(options, env = process.env) {
  const installRoot = options['install-root'];
  if (!installRoot) throw fail('--install-root is required.');
  const worker = Number(options['worker-port'] ?? 4205);
  if (!Number.isInteger(worker) || worker < 1024 || worker > 65534) throw fail('--worker-port must be a port number from 1024 to 65534.');
  const requested = (options.backends ?? BACKENDS.join(',')).split(',');
  if (requested.some((name) => !BACKENDS.includes(name))) throw fail('--backends accepts claude and codex.');
  return {
    platform: process.platform,
    installRoot,
    soulDir: join(installRoot, 'soulstream'),
    atomDir: join(installRoot, 'atom'),
    workspace: join(installRoot, 'workspace'),
    agentHome: join(installRoot, 'agent-home'),
    logsDir: join(installRoot, 'logs'),
    home: options['user-home'] ?? homedir(),
    backends: BACKENDS.filter((name) => requested.includes(name)),
    ports: { orch: 5200, atom: 4200, worker, mcp: worker + 1, postgres: 5432 },
    publicUrl: originOption(options, 'public-url'),
    atomPublicUrl: originOption(options, 'atom-public-url'),
    pgBin: options['pg-bin'] ?? '',
    postgresPassword: env.SOULSTREAM_PG_PASSWORD ?? '',
  };
}

const step = (name) => log(`\n  ${name}`);

async function prepare(ctx, options) {
  ctx.lang = await installationLanguage(ctx, options);
  mkdirSync(ctx.logsDir, { recursive: true });
  mkdirSync(join(ctx.soulDir, 'config'), { recursive: true });
  for (const dir of ['.claude', '.claude-accounts', '.codex']) mkdirSync(join(ctx.agentHome, dir), { recursive: true });
  step('Finding the coding agent CLIs');
  for (const [name, path] of Object.entries(requireClis(ctx.backends))) log(`${name}: ${path}`);
  step('Preparing secrets');
  const secrets = prepareSecrets(ctx, options['admin-password-file']);
  step('Preparing databases');
  setupDatabases(ctx, secrets);
  step('Building atom');
  const atom = buildAtom(ctx);
  step('Initializing atom');
  initAtom(ctx, secrets, atom.dashboard);
  step('Issuing the atom API key and loading atom instructions');
  const seedWarnings = await withTemporaryAtom(ctx, async () => {
    await issueAtomApiKey(ctx, secrets);
    return loadAtomInstructions(ctx);
  });
  step('Writing configuration');
  const rendered = renderConfig({
    platform: ctx.platform, home: ctx.home, root: ctx.soulDir, workspace: ctx.workspace, agentHome: ctx.agentHome, backends: ctx.backends, ports: ctx.ports, secrets,
    atomDashboard: atom.dashboard, publicUrl: ctx.publicUrl, atomPublicUrl: ctx.atomPublicUrl, lang: ctx.lang,
  });
  step('Building Soulstream');
  const pnpm = (args, env) => run('pnpm', args, { cwd: ctx.soulDir, env });
  pnpm(['install', '--frozen-lockfile', '--prod=false']);
  pnpm(['--filter', '@soulstream/soul-server-ts', 'run', 'build'], { SOULSTREAM_RELEASE_ENV_FILE: join(ctx.soulDir, '.env.soul-server-ts') });
  pnpm(['--filter', '@soulstream/orch-server-ts', 'run', 'build']);
  pnpm(['--dir', join(ctx.soulDir, 'unified-dashboard'), 'run', 'build']);
  step('Initializing schema');
  setupSchema(ctx, secrets);
  writeFileSync(join(ctx.soulDir, '.local', 'install-notes.json'), `${JSON.stringify({ lang: ctx.lang, atomDashboard: atom.dashboard, warnings: [...atom.notes, ...rendered.warnings, ...rendered.seedWarnings, ...seedWarnings] })}\n`);
}

async function finish(ctx) {
  const { lang, atomDashboard, warnings: notes } = JSON.parse(readFileSync(join(ctx.soulDir, '.local', 'install-notes.json'), 'utf8'));
  ctx.lang = lang ?? 'ko';
  step('Checking services and workspace');
  await waitAndCreateWorkspace(ctx);
  step('Checking model presets');
  const confirmed = await refreshModelPresets(ctx);
  const head = run('git', ['-C', ctx.soulDir, 'rev-parse', '--short=12', 'HEAD'], { capture: true }).trim();
  log(`\nInstalled ${head}; backends: ${ctx.backends.join(', ')}`);
  const envOrch = join(ctx.soulDir, '.env.orch');
  log(`Soulstream: ${readEnvValue(envOrch, 'SOULSTREAM_PUBLIC_URL') || orchUrl(ctx)}`);
  log(`Atom: ${readEnvValue(envOrch, 'ATOM_PUBLIC_URL') || `http://127.0.0.1:${ctx.ports.atom}`}${atomDashboard ? '' : ' (API only; its dashboard did not build)'}`);
  log(`Password for both: ${readEnvValue(join(ctx.soulDir, '.env.orch'), 'DASHBOARD_ADMIN_PASSWORD')} (saved in ${join(ctx.soulDir, '.admin-password')})`);
  const { profiles, codingAgentsPath } = readInstallerText(ctx.lang);
  log(`PAS: once you connect a coding agent, the dashboard creates a default ${profiles['seosoyoung-pas']} persistent session.`);
  if (notes.length > 0) log(`Notes:\n${notes.map((n) => `  ${n}`).join('\n')}`);
  log(`Login: connect Claude and Codex in the dashboard under ${codingAgentsPath}.`);
  log(confirmed ? 'Model presets are confirmed.' : 'Model preset status is not confirmed yet; it updates within five minutes.');
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  if (command === 'prepare') await prepare(ctx, options);
  else if (command === 'haniel-config') writeFileSync(join(ctx.installRoot, 'haniel.yaml'), renderHanielConfig(ctx));
  else if (command === 'finish') await finish(ctx);
  else throw fail(`Unknown step: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error.installerMessage ? '' : 'Unexpected error: '}${error.message}\n`);
  process.exit(1);
});
