import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFakeCommands, runBash } from './support/fake_commands.mjs';
import { startFakeAtom } from './support/fake_atom_server.mjs';
import { PAS_DISALLOWED_TOOLS } from './support/pas_disallowed_tools.mjs';
import { copyCatalog, copyCommonFiles, installDefaults } from './support/catalog.mjs';

const script = resolve('install/install.sh');
const NAMES = ['skill_catalog', 'domain_catalog', 'common_rules', 'common_rules_extra', 'common_rules_templates', 'codex_rules',
  'claude_common_rules', 'coding_common_rules', 'coding_common_rules_extra', 'seosoyoung_rules', 'seosoyoung_general',
  'seosoyoung_skills', 'seosoyoung_rules_pas', 'seosoyoung_skills_pas', 'seosoyoung_rules_extra_pas', 'card_work_skill_body',
  'node_model_selection_body', 'card_orchestrator_root', 'projects_root', 'mistakes_root'];
const U = Object.fromEntries(NAMES.map((name, i) => [name, `0000000${i % 10}-aaaa-4bbb-8ccc-${String(i + 1).padStart(12, '0')}`]));
const API_KEY = 'test-atom-key_0123456789abcdef';
const PRELUDE = `set -Eeuo pipefail
source "$INSTALL_SH"
as_soul() { if [[ "$1" == git ]]; then printf abc; else "$@"; fi; }
LOG=$FAKE_DIR/install.log
: >> "$LOG"
exec 3>&2
`;
const env = (p) => Object.fromEntries(readFileSync(p, 'utf8').trim().split('\n').filter((x) => /^[A-Z_]+=/.test(x)).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));

// Creates <dir>/home/{soulstream,atom} with a seed map and an API key file (apiKey null: no file).
function setup({ map = U, apiKey = API_KEY } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'install-atom-'));
  const home = join(dir, 'home'), root = join(home, 'soulstream'), atomRoot = join(home, 'atom');
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(atomRoot, { recursive: true });
  copyCatalog(root);
  copyCommonFiles(root);
  if (map !== undefined) writeFileSync(join(root, 'config', '.atom-seed-map.json'), typeof map === 'string' ? map : JSON.stringify(map));
  if (apiKey !== null) writeFileSync(join(root, '.atom-api-key'), `${apiKey}\n`);
  const fake = createFakeCommands(dir);
  const run = async (body, extra = {}) => {
    const result = await runBash(PRELUDE + body, [], { env: fake.env({ INSTALL_SH: script, HOME_DIR: home, ROOT: root, ATOM_ROOT: atomRoot, ...extra }) });
    fake.assertNoProtectedRequests();
    return result;
  };
  const read = (...parts) => readFileSync(join(...parts), 'utf8');
  const log = () => (existsSync(join(dir, 'install.log')) ? read(dir, 'install.log') : '');
  return { dir, home, root, atomRoot, fake, run, read, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const renderBody = (backends) => `parse_args --backends ${backends}\nsetup_secrets "$ROOT" "$ATOM_ROOT"\nrender_config "$HOME_DIR" "$ROOT"\nprintf 'WARNINGS=%s' "$ATOM_SEED_WARNINGS"\n`;

const ctx = (name, depth) => `      - node_id: ${U[name]}\n        depth: ${depth}\n        titles_only: false\n        include_ids: false\n`;
const idx = (name) => `      - node_id: ${U[name]}\n        depth: 1\n        titles_only: false\n        mode: index\n`;
const backendRules = (backend) => (backend === 'claude' ? ctx('claude_common_rules', 5) : backend === 'codex' ? ctx('codex_rules', 5) : '');
const DEFAULTS = installDefaults();
const PRESET = DEFAULTS.backends;
const LABEL = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
function expectedAgents(home, root, backends) {
  const first = backends[0];
  let text = `agents:
  - id: seosoyoung
    name: 서소영
    backend: ${first}
    default_preset: ${PRESET[first]}
    workspace_dir: ${home}/workspace
    disallowed_tools:
      - Workflow
      - ScheduleWakeup
      - AskUserQuestion
      - Skill
      - ReportFindings
      - ListAgents
    claude_auto_memory_enabled: false
    mcp_profile: default
    portrait_path: ${root}/install/assets/portraits/seosoyoung.png
    atom_contexts:
${ctx('common_rules', 5)}${idx('common_rules_extra')}${backendRules(first)}${ctx('seosoyoung_rules', 5)}${ctx('seosoyoung_skills', 1)}  - id: seosoyoung-pas
    name: 서소영 (PAS)
    backend: ${first}
    default_preset: ${PRESET[first]}
    workspace_dir: ${home}/workspace
    disallowed_tools:
${PAS_DISALLOWED_TOOLS.map((tool) => `      - ${tool}\n`).join('')}    context_scope: minimal
    claude_auto_memory_enabled: false
    mcp_profile: pas
    portrait_path: ${root}/install/assets/portraits/seosoyoung-pas.png
    atom_contexts:
${ctx('common_rules', 5)}${backendRules(first)}${ctx('seosoyoung_general', 0)}${ctx('seosoyoung_rules_pas', 5)}${idx('seosoyoung_rules_extra_pas')}${ctx('seosoyoung_skills_pas', 1)}`;
  if (backends.includes('claude')) {
    text += `  - id: card-orchestrator
    name: 카드 오케스트레이터
    backend: claude
    default_preset: ${DEFAULTS.profiles['card-orchestrator']}
    workspace_dir: ${home}/workspace
    context_scope: minimal
    atom_contexts:
${ctx('card_orchestrator_root', 5)}`;
  }
  for (const backend of backends) {
    text += `  - id: ${backend}-default
    name: ${LABEL[backend]}
    backend: ${backend}
    default_preset: ${PRESET[backend]}
    workspace_dir: ${home}/workspace
    mcp_profile: default
    atom_contexts:
${ctx('common_rules', 5)}${idx('common_rules_extra')}${ctx('coding_common_rules', 5)}${ctx('coding_common_rules_extra', 0)}${backendRules(backend)}`;
  }
  return text;
}
const EXPECTED_REGISTRY = `servers:
  - id: soulstream
    type: streamable_http
    url: http://127.0.0.1:4205/mcp
    headers:
      Authorization:
        env: PORTABLE_LOCAL_MCP_AUTHORIZATION
  - id: atom
    type: streamable_http
    url: http://127.0.0.1:4200/mcp
    headers:
      x-api-key:
        env: ATOM_API_KEY
`;
const EXPECTED_PROFILES = `profiles:
  - id: default
    name: Default
    mcp_servers: [soulstream, atom]
  - id: pas
    name: PAS
    mcp_servers: [soulstream, atom]
`;
const EXPECTED_AGENTS_MD = `# Soulstream workspace

Use this shared workspace for your work. Create project worktrees under \`.projects/<repository>--<branch>\`.
Keep temporary scripts in \`.local/tmp\` and work products in \`.local/artifacts\`.
Scripts of shared and custom skills live under \`$AGENT_COMMON_FILES_DIR/skills/<skill>/\`.
The \`soulstream\` MCP server provides session and workspace tools.
The \`atom\` MCP server holds your instructions and skills. Rules live under \`에이전트 > 공통 > rules\` and skills under \`에이전트 > 공통 > skills\`.
Find skills with \`search_skills\` and read them with \`load_skill\`. Read any other atom node with \`compile_subtree\`.
`;

test('installer refuses missing catalog defaults', async () => {
  const t = setup();
  try {
    unlinkSync(join(t.root, 'packages/model-catalog/data/model-catalog.yaml'));
    const result = await t.run('parse_args --backends claude\nsetup_secrets "$ROOT" "$ATOM_ROOT"\nrender_config "$HOME_DIR" "$ROOT"\n');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /install_defaults|model-catalog/);
  } finally { t.cleanup(); }
});

test('installer renders each backend and profile from the checked-out catalog', async () => {
  const t = setup();
  try {
    const path = join(t.root, 'packages/model-catalog/data/model-catalog.yaml');
    const defaults = { backends: { claude: 'test-claude', codex: 'test-codex', antigravity: 'test-antigravity' }, profiles: { 'card-orchestrator': 'test-orchestrator' } };
    const raw = readFileSync(path, 'utf8');
    writeFileSync(path, raw.replace(/^install_defaults: .*$/m, `install_defaults: ${JSON.stringify(defaults)}`));
    const result = await t.run(renderBody('claude,codex,antigravity'));
    assert.equal(result.status, 0, result.stderr);
    const agents = t.read(t.root, 'config', 'agents.yaml');
    assert.equal((agents.match(/default_preset: test-claude/g) ?? []).length, 3);
    for (const value of ['test-codex', 'test-antigravity', 'test-orchestrator']) assert.ok(agents.includes(`default_preset: ${value}`));
    const stage1 = await t.run('stage1_managed_output agents "$HOME_DIR" claude,codex,antigravity "$STAGE1_PRESETS"\n', { STAGE1_PRESETS: resolve('install/stage1-managed-presets.json') });
    assert.equal(stage1.status, 0, stage1.stderr);
    const expectedStage1 = readFileSync(resolve('install/tests/fixtures/stage1/claude-codex-antigravity/agents.yaml'), 'utf8').replaceAll('/home/soulstream', t.home);
    assert.equal(stage1.stdout, expectedStage1);
    writeFileSync(path, raw.replace(/^install_defaults: .*$/m, 'install_defaults: {"backends":{}}'));
    const missing = await t.run(renderBody('claude'));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /install_defaults/);
  } finally { t.cleanup(); }
});

test('a full seed map renders atom env lines, profiles, MCP files and AGENTS.md', async () => {
  for (const backends of ['claude,codex', 'codex', 'antigravity,claude']) {
    const t = setup();
    try {
      const result = await t.run(renderBody(backends));
      assert.equal(result.status, 0, result.stderr);
      const orch = env(join(t.root, '.env.orch')), worker = env(join(t.root, '.env.soul-server-ts'));
      assert.deepEqual(
        ['ATOM_ENABLED', 'ATOM_SERVER_URL', 'ATOM_API_KEY', 'SKILL_CATALOG_NODE_ID', 'DOMAIN_CATALOG_NODE_ID', 'DEFAULT_PAS_AGENT_ID'].map((k) => orch[k]),
        ['true', 'http://127.0.0.1:4200', API_KEY, U.skill_catalog, U.domain_catalog, 'seosoyoung-pas']);
      assert.deepEqual(['ATOM_ENABLED', 'ATOM_SERVER_URL', 'ATOM_API_KEY'].map((k) => worker[k]), ['true', 'http://127.0.0.1:4200', API_KEY]);
      assert.equal(t.read(t.root, 'config', 'agents.yaml'), expectedAgents(t.home, t.root, backends.split(',')), backends);
      assert.equal(t.read(t.root, 'config', 'mcp-registry.yaml'), EXPECTED_REGISTRY);
      assert.equal(t.read(t.root, 'config', 'mcp-profiles.yaml'), EXPECTED_PROFILES);
      assert.equal(t.read(t.home, 'workspace', 'AGENTS.md'), EXPECTED_AGENTS_MD);
      assert.equal(result.stdout, 'WARNINGS=');
    } finally { t.cleanup(); }
  }
});

test('null map values leave the catalog empty and drop only that context', async () => {
  const t = setup({ map: { ...U, skill_catalog: null, seosoyoung_rules: null } });
  try {
    const result = await t.run(renderBody('claude,codex'));
    assert.equal(result.status, 0, result.stderr);
    const lines = t.read(t.root, '.env.orch').split('\n');
    assert.ok(lines.includes('SKILL_CATALOG_NODE_ID='));
    assert.ok(lines.includes(`DOMAIN_CATALOG_NODE_ID=${U.domain_catalog}`));
    const full = expectedAgents(t.home, t.root, ['claude', 'codex']);
    assert.equal(t.read(t.root, 'config', 'agents.yaml'), full.replace(ctx('seosoyoung_rules', 5), ''));
    assert.ok(full.includes(ctx('seosoyoung_rules', 5)));
  } finally { t.cleanup(); }
});

test('a map value with a newline is ignored with a warning and cannot add env lines', async () => {
  const t = setup({ map: { ...U, skill_catalog: `${U.skill_catalog}\nEVIL=1`, domain_catalog: `${U.domain_catalog}\n` } });
  try {
    const result = await t.run(renderBody('claude'));
    assert.equal(result.status, 0, result.stderr);
    for (const file of ['.env.orch', '.env.soul-server-ts']) assert.ok(!/^EVIL/m.test(t.read(t.root, file)), file);
    const orch = env(join(t.root, '.env.orch'));
    assert.equal(orch.SKILL_CATALOG_NODE_ID, '');
    assert.equal(orch.DOMAIN_CATALOG_NODE_ID, '');
    assert.match(result.stdout, /atom seed map: ignored invalid value for skill_catalog/);
    assert.match(result.stdout, /atom seed map: ignored invalid value for domain_catalog/);
  } finally { t.cleanup(); }
});

test('an empty map renders empty catalogs and no atom contexts', async () => {
  const t = setup({ map: {} });
  try {
    const result = await t.run(renderBody('claude,codex,antigravity'));
    assert.equal(result.status, 0, result.stderr);
    const orch = env(join(t.root, '.env.orch'));
    assert.equal(orch.SKILL_CATALOG_NODE_ID, '');
    assert.equal(orch.DOMAIN_CATALOG_NODE_ID, '');
    const agents = t.read(t.root, 'config', 'agents.yaml');
    assert.ok(!/^ {4}atom_contexts:$/m.test(agents));
    assert.equal([...agents.matchAll(/^  - id: /gm)].length, 6);
  } finally { t.cleanup(); }
});

test('PERSISTENT_SESSION_BOOTSTRAP is written as true and a rerun refreshes an edited value', async () => {
  const t = setup();
  try {
    const first = await t.run('parse_args --backends claude\nsetup_secrets "$ROOT" "$ATOM_ROOT"\ninit_atom "$ATOM_ROOT"\nrender_config "$HOME_DIR" "$ROOT"\n');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(env(join(t.root, '.env.orch')).PERSISTENT_SESSION_BOOTSTRAP, 'true');
    writeFileSync(join(t.root, '.env.orch'), `${t.read(t.root, '.env.orch').replace('PERSISTENT_SESSION_BOOTSTRAP=true', 'PERSISTENT_SESSION_BOOTSTRAP=false')}`);
    assert.equal(env(join(t.root, '.env.orch')).PERSISTENT_SESSION_BOOTSTRAP, 'false');
    const second = await t.run('parse_args --backends claude\nsetup_secrets "$ROOT" "$ATOM_ROOT"\ninit_atom "$ATOM_ROOT"\nrender_config "$HOME_DIR" "$ROOT"\n');
    assert.equal(second.status, 0, second.stderr);
    const orchText = t.read(t.root, '.env.orch');
    assert.equal(env(join(t.root, '.env.orch')).PERSISTENT_SESSION_BOOTSTRAP, 'true');
    assert.equal(orchText.split('\n').filter((line) => line.startsWith('PERSISTENT_SESSION_BOOTSTRAP=')).length, 1);
  } finally { t.cleanup(); }
});

test('user lines survive in .env.orch and atom/.env while managed keys change and secrets persist', async () => {
  const t = setup();
  try {
    writeFileSync(join(t.root, '.env.orch'), 'GOOGLE_CLIENT_ID=x\nATOM_ENABLED=false\nDEFAULT_PAS_AGENT_ID=claude-default\n');
    writeFileSync(join(t.atomRoot, '.env'), 'CUSTOM_SETTING=kept\nAPI_PORT=9999\nJWT_SECRET=existing-atom-jwt\nDASHBOARD_ADMIN_PASSWORD=existing-admin-password\n');
    const result = await t.run('parse_args --backends claude\nsetup_secrets "$ROOT" "$ATOM_ROOT"\ninit_atom "$ATOM_ROOT"\nrender_config "$HOME_DIR" "$ROOT"\n');
    assert.equal(result.status, 0, result.stderr);
    const orch = env(join(t.root, '.env.orch')), atom = env(join(t.atomRoot, '.env'));
    assert.equal(orch.GOOGLE_CLIENT_ID, 'x');
    assert.equal(orch.ATOM_ENABLED, 'true');
    assert.equal(orch.DEFAULT_PAS_AGENT_ID, 'seosoyoung-pas');
    assert.equal(atom.CUSTOM_SETTING, 'kept');
    assert.equal(atom.API_PORT, '4200');
    assert.equal(atom.JWT_SECRET, 'existing-atom-jwt');
    assert.equal(atom.DASHBOARD_ADMIN_PASSWORD, 'existing-admin-password');
    assert.equal(orch.DASHBOARD_ADMIN_PASSWORD, 'existing-admin-password');
    assert.equal(t.read(t.root, '.admin-password'), 'existing-admin-password\n');
    for (const [file, key] of [[join(t.root, '.env.orch'), 'ATOM_ENABLED'], [join(t.atomRoot, '.env'), 'API_PORT']]) {
      assert.equal(readFileSync(file, 'utf8').split('\n').filter((x) => x.startsWith(`${key}=`)).length, 1);
    }
    assert.match(t.fake.argv(), /== npm\n--prefix\n.*\/home\/atom\nrun\nmigrate\n/);
  } finally { t.cleanup(); }
});

test('atom/.env is private and FRONTEND_URL follows the access mode', async () => {
  for (const [mode, url] of [['false', 'http://127.0.0.1:4200'], ['true', 'https://node.tailnet.ts.net:8443']]) {
    const t = setup();
    try {
      const result = await t.run('parse_args\nTAILSCALE=$MODE; TAILSCALE_DNS=node.tailnet.ts.net\nsetup_secrets "$ROOT" "$ATOM_ROOT"\ninit_atom "$ATOM_ROOT"\n', { MODE: mode });
      assert.equal(result.status, 0, result.stderr);
      const file = join(t.atomRoot, '.env');
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const atom = env(file);
      assert.equal(atom.FRONTEND_URL, url);
      assert.deepEqual(Object.keys(atom).sort(), ['API_HOST', 'API_PORT', 'DASHBOARD_ADMIN_PASSWORD', 'DASHBOARD_DIR', 'DATABASE_URL', 'FRONTEND_URL', 'JWT_SECRET', 'NODE_ENV']);
      assert.equal(atom.DASHBOARD_DIR, `${t.atomRoot}/dashboard/dist`);
      assert.match(atom.DATABASE_URL, /^postgresql:\/\/soulstream:[0-9a-f]{64}@127\.0\.0\.1:5432\/atom$/);
      assert.match(atom.JWT_SECRET, /^[0-9a-f]{64}$/);
    } finally { t.cleanup(); }
  }
});

test('the atom unit runs the built API as soulstream before Soulstream services', async () => {
  const t = setup();
  try {
    const unitDir = join(t.dir, 'units');
    mkdirSync(unitDir);
    const result = await t.run('write_atom_unit "$UNIT_DIR" /home/soulstream/atom\n', { UNIT_DIR: unitDir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(unitDir, 'soulstream-atom.service'), 'utf8'), `[Unit]
Description=Soulstream atom
After=network.target postgresql.service
Before=soulstream-orch.service soulstream-worker.service
[Service]
User=soulstream
WorkingDirectory=/home/soulstream/atom
EnvironmentFile=/home/soulstream/atom/.env
Environment=HOME=/home/soulstream
Environment=PATH=/home/soulstream/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/node /home/soulstream/atom/dist/api/index.js
Restart=on-failure
[Install]
WantedBy=multi-user.target
`);
  } finally { t.cleanup(); }
});

// API key step against the fake atom server.
async function issueKey({ storedKey, keys = {}, secret = 'issued-key_abcdef0123456789' }) {
  const t = setup({ apiKey: storedKey });
  writeFileSync(join(t.root, '.admin-password'), '  admin-password-for-key  \n');
  const server = await startFakeAtom({ keys, password: 'admin-password-for-key', secret });
  try {
    const result = await t.run('ATOM_URL=$FAKE_ATOM_URL\nissue_atom_api_key "$ROOT"\n', { FAKE_ATOM_URL: server.url });
    const keyPath = join(t.root, '.atom-api-key');
    return { t, result, requests: server.requests.map((r) => ({ ...r })), key: existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : null, keyPath, leftovers: readdirSync(t.fake.tmp).concat(readdirSync(t.root).filter((name) => name.startsWith('.atom-api-key.'))) };
  } finally { await server.close(); }
}
const calls = (requests) => requests.map((r) => `${r.method} ${r.path}`);

test('an accepted stored key is kept without login or issuance', async () => {
  const { t, result, requests, key, leftovers } = await issueKey({ storedKey: 'stored-key-1', keys: { 'stored-key-1': 200 } });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(requests), ['GET /api/tree/outline']);
    assert.equal(requests[0].apiKey, 'stored-key-1');
    assert.equal(key, 'stored-key-1\n');
    assert.deepEqual(leftovers, []);
  } finally { t.cleanup(); }
});

test('a rejected stored key is replaced by a new key after login and verification', async () => {
  const { t, result, requests, key, keyPath, leftovers } = await issueKey({ storedKey: 'stored-key-1', keys: { 'stored-key-1': 401 } });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(requests), ['GET /api/tree/outline', 'POST /api/auth/password-login', 'POST /api/config/agents', 'GET /api/tree/outline']);
    assert.deepEqual(JSON.parse(requests[1].body), { password: 'admin-password-for-key' });
    assert.equal(requests[3].apiKey, 'issued-key_abcdef0123456789');
    assert.equal(key, 'issued-key_abcdef0123456789\n');
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    assert.deepEqual(leftovers, []);
  } finally { t.cleanup(); }
});

test('a failing key check stops without issuing and keeps the stored key', async () => {
  const { t, result, requests, key, leftovers } = await issueKey({ storedKey: 'stored-key-1', keys: { 'stored-key-1': 500 } });
  try {
    assert.notEqual(result.status, 0);
    assert.deepEqual(calls(requests), ['GET /api/tree/outline']);
    assert.equal(key, 'stored-key-1\n');
    assert.deepEqual(leftovers, []);
  } finally { t.cleanup(); }
});

test('a missing key file issues a write-scoped key for a Soulstream agent', async () => {
  const { t, result, requests, key, leftovers } = await issueKey({ storedKey: null });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(requests), ['POST /api/auth/password-login', 'POST /api/config/agents', 'GET /api/tree/outline']);
    const body = JSON.parse(requests[1].body);
    assert.equal(body.scope, 'write');
    assert.match(body.agent_id, /^soulstream-\d{14}$/);
    assert.equal(body.display_name, 'Soulstream');
    assert.equal(key, 'issued-key_abcdef0123456789\n');
    assert.ok(!result.stdout.includes('issued-key') && !result.stderr.includes('issued-key') && !t.log().includes('issued-key'));
    assert.deepEqual(leftovers, []);
  } finally { t.cleanup(); }
});

test('an issued secret with an unexpected format fails without writing the key file', async () => {
  const { t, result, key, leftovers } = await issueKey({ storedKey: null, secret: 'bad key\nEVIL=1' });
  try {
    assert.notEqual(result.status, 0);
    assert.equal(key, null);
    assert.deepEqual(leftovers, []);
  } finally { t.cleanup(); }
});

test('the seed loader runs with the installer paths and its warnings reach the finish message', async () => {
  for (const exit of ['0', '1']) {
    const t = setup();
    try {
      mkdirSync(join(t.root, 'install', 'seed'), { recursive: true });
      writeFileSync(join(t.root, 'install', 'seed', 'load_atom_seed.mjs'),
        "process.stdout.write('atom seed: preserved\\nWARNING: existing atom tree kept; seed not loaded\\n');\nprocess.exitCode = Number(process.env.FAKE_LOADER_EXIT);\n");
      const result = await t.run("parse_args --backends codex\nATOM_URL=http://127.0.0.1:9\nrun_step 'Loading atom instructions' load_atom_instructions \"$ROOT\"\nfinish_message \"$ROOT\"\n", { FAKE_LOADER_EXIT: exit });
      assert.match(t.fake.argv(), new RegExp(`== node\n${t.root}/install/seed/load_atom_seed\\.mjs\n--atom-url\nhttp://127\\.0\\.0\\.1:9\n--password-file\n${t.root}/\\.admin-password\n--state-dir\n${t.root}/config\n`));
      assert.match(t.log(), /^atom seed: preserved$/m);
      if (exit === '0') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /\nAtom instructions:\n {2}existing atom tree kept; seed not loaded\n/);
      } else {
        assert.notEqual(result.status, 0);
        assert.ok(!result.stdout.includes('Atom instructions:'));
      }
    } finally { t.cleanup(); }
  }
});

test('a Soulstream revision without atom support stops before atom is cloned', async () => {
  const t = setup();
  try {
    // A local bare origin; git ignores the host configuration.
    const gitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...gitEnv } });
    const origin = join(t.dir, 'soulstream.git'), work = join(t.dir, 'soulstream-work');
    rmSync(t.atomRoot, { recursive: true });
    rmSync(t.root, { recursive: true });
    git('init', '-q', '--bare', '--initial-branch=main', origin);
    git('init', '-q', '--initial-branch=main', work);
    git('-C', work, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'stage one');
    git('-C', work, 'push', '-q', origin, 'HEAD:refs/heads/beta');
    git('clone', '-q', '--branch', 'beta', origin, t.root);
    const result = await t.run('as_soul() { "$@"; }\nSOULSTREAM_REPO_URL=$ORIGIN; ATOM_REPO_URL=$ORIGIN.missing; SYSTEMD_DIR=$FAKE_DIR/units\nparse_args\ncheck_repositories "$ROOT" "$ATOM_ROOT"\n', { ...gitEnv, ORIGIN: origin });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /The selected Soulstream revision predates atom support\./);
    assert.ok(!existsSync(t.atomRoot));
    assert.ok(!t.fake.argv().includes('== systemctl\n'));
  } finally { t.cleanup(); }
});

test('secrets never reach argv, output or the installation log', async () => {
  const secrets = { admin: 'SynthAdminPass4e1f9c', db: 'SynthDbPass77a2d0', oldKey: 'SynthOldKey93b1e8', newKey: 'SynthNewKey1d6f42', tailscale: 'SynthTsKey5c0a71' };
  const t = setup({ apiKey: secrets.oldKey });
  const server = await startFakeAtom({ keys: { [secrets.oldKey]: 401 }, password: secrets.admin, secret: secrets.newKey });
  try {
    writeFileSync(join(t.root, '.admin-password'), `${secrets.admin}\n`);
    writeFileSync(join(t.root, '.env.orch'), `DATABASE_URL=postgresql://soulstream:${secrets.db}@127.0.0.1:5432/soulstream\n`);
    const tsKey = join(t.dir, 'tailscale-key');
    writeFileSync(tsKey, secrets.tailscale, { mode: 0o600 });
    const result = await t.run(`parse_args --backends claude,codex --tailscale --tailscale-auth-key-file "$TS_KEY"
ATOM_URL=$FAKE_ATOM_URL
STEP='Setting up Tailscale'; printf '%s\\n' "$STEP"; setup_tailscale
run_step 'Preparing secrets' setup_secrets "$ROOT" "$ATOM_ROOT"
run_step 'Preparing databases' setup_database
run_step 'Initializing atom' init_atom "$ATOM_ROOT"
run_step 'Issuing atom API key' issue_atom_api_key "$ROOT"
run_step 'Writing configuration' write_configuration "$HOME_DIR" "$ROOT"
finish_message "$ROOT"
`, { FAKE_ATOM_URL: server.url, TS_KEY: tsKey });
    assert.equal(result.status, 0, result.stderr);
    // The secrets were really used, so their absence below is meaningful.
    assert.ok(t.read(t.atomRoot, '.env').includes(`soulstream:${secrets.db}@`));
    assert.ok(t.read(t.atomRoot, '.env').includes(`DASHBOARD_ADMIN_PASSWORD=${secrets.admin}`));
    assert.equal(env(join(t.root, '.env.orch')).ATOM_API_KEY, secrets.newKey);
    assert.deepEqual(calls(server.requests), ['GET /api/tree/outline', 'POST /api/auth/password-login', 'POST /api/config/agents', 'GET /api/tree/outline']);
    const argv = t.fake.argv();
    assert.match(argv, new RegExp(`== tailscale\nup\n--auth-key=file:${tsKey}\n`));
    assert.match(argv, /== createdb\n-O\nsoulstream\nsoulstream\n[^]*== createdb\n-O\nsoulstream\natom\n/);
    for (const command of ['sudo', 'psql', 'curl', 'jq', 'npm', 'tailscale']) assert.ok(argv.includes(`== ${command}\n`), command);
    for (const [name, value] of Object.entries(secrets)) {
      assert.ok(!argv.includes(value), `argv contains ${name}`);
      assert.ok(!result.stdout.includes(value), `stdout contains ${name}`);
      assert.ok(!result.stderr.includes(value), `stderr contains ${name}`);
      assert.ok(!t.log().includes(value), `log contains ${name}`);
    }
    assert.match(result.stdout, new RegExp(`Atom: https://node\\.tailnet\\.ts\\.net:8443 \\(password: sudo cat ${t.root}/\\.admin-password\\)`));

    // A failing role creation echoes its stdin; the installer keeps it out of the log.
    const failed = await t.run("parse_args\nrun_step 'Preparing secrets' setup_secrets \"$ROOT\" \"$ATOM_ROOT\"\nrun_step 'Preparing databases' setup_database\n", { FAKE_PSQL_FAIL: '1' });
    assert.notEqual(failed.status, 0);
    assert.match(t.log(), /Failed to create PostgreSQL role soulstream\./);
    for (const output of [t.log(), failed.stdout, failed.stderr]) assert.ok(!output.includes(secrets.db));

    // An existing role is updated to the current DB password through stdin; a failure leaves one line in the log.
    const dbSteps = "parse_args\nrun_step 'Preparing secrets' setup_secrets \"$ROOT\" \"$ATOM_ROOT\"\nrun_step 'Preparing databases' setup_database\n";
    writeFileSync(join(t.dir, 'install.log'), '');
    const altered = await t.run(dbSteps, { FAKE_ROLE_EXISTS: '1' });
    assert.equal(altered.status, 0, altered.stderr);
    assert.ok(t.fake.psqlStdin().includes(`ALTER ROLE soulstream LOGIN PASSWORD '${secrets.db}';`));
    const alterFailed = await t.run(dbSteps, { FAKE_ROLE_EXISTS: '1', FAKE_PSQL_FAIL: '1' });
    assert.notEqual(alterFailed.status, 0);
    assert.match(t.log(), /Failed to update PostgreSQL role soulstream\./);
    assert.doesNotMatch(t.log(), /Failed to create PostgreSQL role/);
    for (const output of [t.fake.argv(), t.log(), altered.stdout, altered.stderr, alterFailed.stdout, alterFailed.stderr]) {
      assert.ok(!output.includes(secrets.db));
      assert.ok(!output.includes('ALTER ROLE'));
    }
  } finally { await server.close(); t.cleanup(); }
});

test('main runs the installation steps in order', () => {
  const text = readFileSync(script, 'utf8');
  const fn = (name) => text.slice(text.indexOf(`\n${name}() {`), text.indexOf('\n}\n', text.indexOf(`\n${name}() {`)));
  assert.match(fn('main'), /\n {2}run_install \/home\/soulstream \/home\/soulstream\/soulstream \/home\/soulstream\/atom$/);
  assert.deepEqual([...fn('run_install').matchAll(/run_step '([^']+)'/g)].map((m) => m[1]), [
    'Installing packages', 'Setting up account', 'Installing Node.js', 'Installing selected CLIs',
    'Checking repositories', 'Stopping services', 'Checking out revisions',
    'Preparing secrets', 'Preparing databases', 'Building atom', 'Initializing atom',
    'Starting atom', 'Issuing atom API key', 'Loading atom instructions',
    'Writing configuration', 'Building Soulstream', 'Initializing schema', 'Starting services',
    'Enabling Tailscale Serve', 'Checking services and workspace', 'Checking model presets',
  ]);
});

test('render_config points the worker at the skill script bundle, syncs it and keeps files the user added', async () => {
  const t = setup();
  try {
    assert.equal((await t.run(renderBody('claude,codex'))).status, 0);
    const bundleDir = join(t.root, '.local', 'agent-common');
    assert.equal(env(join(t.root, '.env.soul-server-ts')).AGENT_COMMON_FILES_DIR, bundleDir);
    assert.equal(env(join(t.root, '.env.orch')).AGENT_COMMON_FILES_DIR, undefined);
    const checker = join(bundleDir, 'skills', 'html-make', 'scripts', 'check-ui-css.mjs');
    assert.ok(readFileSync(checker).equals(readFileSync(resolve('scripts/check-ui-css.mjs'))));
    assert.ok(existsSync(join(bundleDir, 'skills', 'html-make', 'scripts', 'ui-css-check.config.json')));
    for (const dir of ['.projects', '.local/tmp', '.local/artifacts']) assert.ok(statSync(join(t.home, 'workspace', dir)).isDirectory(), dir);

    mkdirSync(join(bundleDir, 'skills', 'my-custom'), { recursive: true });
    writeFileSync(join(bundleDir, 'skills', 'my-custom', 'run.mjs'), 'console.log("mine");\n');
    writeFileSync(checker, '// edited\n');
    assert.equal((await t.run(renderBody('claude,codex'))).status, 0);
    assert.equal(t.read(bundleDir, 'skills', 'my-custom', 'run.mjs'), 'console.log("mine");\n');
    assert.ok(readFileSync(checker).equals(readFileSync(resolve('scripts/check-ui-css.mjs'))), 'a bundled file is restored');
    assert.equal(t.read(t.home, 'workspace', 'AGENTS.md'), EXPECTED_AGENTS_MD);
  } finally { t.cleanup(); }
});

test('render_config stops when the checkout has no skill script bundle', async () => {
  const t = setup();
  try {
    rmSync(join(t.root, 'install', 'common-files'), { recursive: true });
    const result = await t.run(renderBody('claude,codex'));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing bundled skill scripts/);
  } finally { t.cleanup(); }
});
