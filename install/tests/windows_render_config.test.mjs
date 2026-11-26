import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { createFakeCommands } from './support/fake_commands.mjs';
import { copyCatalog } from './support/catalog.mjs';
import { PAS_DISALLOWED_TOOLS as SUPPORT_PAS_TOOLS } from './support/pas_disallowed_tools.mjs';
import { PAS_DISALLOWED_TOOLS } from '../windows/pas_disallowed_tools.mjs';
import { renderConfig, renderEnvFiles } from '../windows/render_config.mjs';

const script = resolve('install/install.sh');
const SEED_MAP = { skill_catalog: '11111111-2222-4333-8444-555555555555', domain_catalog: null, common_rules: '22222222-2222-4333-8444-555555555555', codex_rules: '33333333-2222-4333-8444-555555555555', claude_common_rules: 'not-a-uuid' };
const PORTS = { orch: 5200, atom: 4200, worker: 4205, mcp: 4206, postgres: 5432 };
const OUTPUTS = ['.env.orch', '.env.soul-server-ts', 'config/agents.yaml', 'config/mcp-registry.yaml', 'config/mcp-profiles.yaml', 'config/.installer-managed.sha256'];

const envValue = (file, key) => readFileSync(file, 'utf8').split('\n').find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);

function bashRender(home, root, backends, fake) {
  const run = spawnSync('bash', ['-c', 'set -Eeuo pipefail; source "$1"; BACKENDS="$4"; setup_secrets "$3" "$2/atom"; render_config "$2" "$3"', 'bash', script, home, root, backends], { encoding: 'utf8', env: fake.env() });
  assert.equal(run.status, 0, run.stderr);
}

function snapshot(home, root) {
  const files = Object.fromEntries(OUTPUTS.map((name) => [name, readFileSync(join(root, name))]));
  files['workspace/AGENTS.md'] = readFileSync(join(home, 'workspace', 'AGENTS.md'));
  files['workspace/CLAUDE.md link'] = Buffer.from(readlinkSync(join(home, 'workspace', 'CLAUDE.md')));
  return files;
}

test('the Node renderer writes the same bytes as bash render_config on linux', () => {
  const dir = mkdtempSync(join(tmpdir(), 'windows-render-eq-')), home = join(dir, 'home'), root = join(home, 'soulstream');
  try {
    const fake = createFakeCommands(dir);
    copyCatalog(root);
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', '.atom-seed-map.json'), JSON.stringify(SEED_MAP));
    writeFileSync(join(root, '.atom-api-key'), 'test-atom-api-key\n');
    for (const backends of ['claude,codex', 'codex', 'claude', 'antigravity', 'claude,codex,antigravity']) {
      bashRender(home, root, backends, fake);
      const expected = snapshot(home, root);
      const orch = join(root, '.env.orch');
      const secrets = {
        bearer: envValue(orch, 'AUTH_BEARER_TOKEN'),
        jwt: envValue(orch, 'JWT_SECRET'),
        dbPassword: /^postgresql:\/\/soulstream:([^@]+)@/.exec(envValue(orch, 'DATABASE_URL'))[1],
        adminPassword: envValue(orch, 'DASHBOARD_ADMIN_PASSWORD'),
      };
      for (const name of OUTPUTS) rmSync(join(root, name));
      rmSync(join(home, 'workspace', 'AGENTS.md'));
      rmSync(join(home, 'workspace', 'CLAUDE.md'));
      const result = renderConfig({ platform: 'linux', home, root, backends: backends.split(','), ports: PORTS, secrets });
      assert.deepEqual(result.seedWarnings, ['atom seed map: ignored invalid value for claude_common_rules']);
      const actual = snapshot(home, root);
      for (const name of Object.keys(expected)) assert.ok(actual[name].equals(expected[name]), `${backends}: ${name}`);
    }
    assert.ok(lstatSync(join(home, 'workspace', 'CLAUDE.md')).isSymbolicLink());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a second render keeps what you edited and the secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'windows-render-keep-')), home = join(dir, 'home'), root = join(home, 'soulstream');
  try {
    copyCatalog(root);
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', '.atom-seed-map.json'), JSON.stringify(SEED_MAP));
    writeFileSync(join(root, '.atom-api-key'), 'test-atom-api-key\n');
    const options = { platform: 'linux', home, root, backends: ['claude', 'codex'], ports: PORTS, secrets: { bearer: 'b', jwt: 'j', dbPassword: 'd', adminPassword: 'adminpass1' } };
    renderConfig(options);
    writeFileSync(join(root, '.env.orch'), `${readFileSync(join(root, '.env.orch'), 'utf8')}GOOGLE_CLIENT_ID=x\n`);
    writeFileSync(join(root, 'config', 'mcp-profiles.yaml'), 'profiles: []\n');
    const second = renderConfig(options);
    assert.equal(envValue(join(root, '.env.orch'), 'GOOGLE_CLIENT_ID'), 'x');
    assert.equal(readFileSync(join(root, '.env.orch'), 'utf8').split('\n').filter((l) => l.startsWith('PORT=')).length, 1);
    assert.equal(readFileSync(join(root, 'config', 'mcp-profiles.yaml'), 'utf8'), 'profiles: []\n');
    assert.ok(existsSync(join(root, 'config', 'mcp-profiles.yaml.installer-new')));
    assert.equal(second.warnings.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the PAS tool list is the one install.sh writes', () => {
  assert.deepEqual(PAS_DISALLOWED_TOOLS, SUPPORT_PAS_TOOLS);
  const bash = spawnSync('bash', ['-c', 'source "$1"; pas_disallowed_tools_yaml', 'bash', script], { encoding: 'utf8' });
  assert.equal(bash.status, 0, bash.stderr);
  assert.deepEqual(bash.stdout.trim().split('\n').map((line) => line.trim().slice(2)), PAS_DISALLOWED_TOOLS);
});

test('the win32 render uses Windows paths, no process runner and no agy', () => {
  const root = 'C:\\Users\\Jane Doe\\AppData\\Local\\Soulstream\\soulstream';
  const workspace = 'C:\\Users\\Jane Doe\\AppData\\Local\\Soulstream\\workspace';
  const home = 'C:\\Users\\Jane Doe';
  const agentHome = 'C:\\Users\\Jane Doe\\AppData\\Local\\Soulstream\\agent-home';
  const { orch, worker } = renderEnvFiles({
    platform: 'win32', home, root, workspace, agentHome, path: win32, ports: { ...PORTS, worker: 4305, mcp: 4306 },
    secrets: { bearer: 'b', jwt: 'j', dbPassword: 'd', adminPassword: 'adminpass1' }, atomApiKey: 'k', backends: ['claude', 'codex'], nodes: {},
  });
  assert.ok(worker.includes('SESSION_ISOLATION_MODE=off'));
  assert.ok(worker.includes('SOUL_RUNNER_PROCESS_ENABLED=false'));
  assert.ok(worker.includes('PORT=4305') && worker.includes('MCP_INTERNAL_PORT=4306'));
  assert.ok(worker.includes(`AGENTS_CONFIG_PATH=${root}\\config\\agents.yaml`));
  assert.ok(worker.includes(`WORKTREE_PROJECTS_ROOT=${workspace}\\.projects`));
  for (const line of [
    `CLAUDE_ACCOUNTS_DIR=${agentHome}\\.claude-accounts`,
    `CLAUDE_SHARED_HOME_DIR=${agentHome}`,
    `CLAUDE_CONFIG_DIR=${agentHome}\\.claude`,
    `CLAUDE_AUTH_TOKEN_PATH=${agentHome}\\.claude\\.credentials.json`,
    `CODEX_HOME=${agentHome}\\.codex`,
  ]) assert.ok(worker.includes(line), line);
  assert.ok(!worker.some((line) => line.includes(`=${home}\\.`)), 'no worker path points into the user home');
  assert.ok(orch.includes(`DASHBOARD_DIR=${root}\\unified-dashboard\\dist`));
  assert.ok(![...orch, ...worker].some((line) => /AGY|SOUL_RUNNER_(STATE|ARTIFACT|RELEASES)/.test(line)));
  assert.ok(orch.includes('ATOM_PUBLIC_URL=http://127.0.0.1:4200'));
  const withoutAtomDashboard = renderEnvFiles({
    platform: 'win32', home, root, workspace, agentHome, path: win32, ports: PORTS, atomDashboard: false,
    secrets: { bearer: 'b', jwt: 'j', dbPassword: 'd', adminPassword: 'adminpass1' }, atomApiKey: 'k', backends: ['claude'], nodes: {},
  });
  assert.ok(withoutAtomDashboard.orch.includes('ATOM_PUBLIC_URL='));
});
