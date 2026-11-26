// Writes the configuration files of install.sh render_config (install.sh:654-787) from Node.
// With platform "linux" and Linux paths the output is byte for byte what bash writes; the install tests keep it so.
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { posix, win32 } from 'node:path';
import { PAS_DISALLOWED_TOOLS } from './pas_disallowed_tools.mjs';

export const ATOM_API_KEY_RE = /^[A-Za-z0-9._~+/=-]+$/;
const ATOM_SEED_NAMES = 'skill_catalog domain_catalog common_rules common_rules_extra codex_rules claude_common_rules coding_common_rules coding_common_rules_extra seosoyoung_rules seosoyoung_general seosoyoung_skills seosoyoung_rules_pas seosoyoung_skills_pas seosoyoung_rules_extra_pas card_orchestrator_root'.split(' ');
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BACKEND_NAMES = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
const BACKEND_RULES = { claude: 'claude_common_rules:5', codex: 'codex_rules:5' };

const ORCH_KEYS = 'ENVIRONMENT HOST PORT DEFAULT_EXECUTION_NODE_ID DEFAULT_PAS_AGENT_ID PERSISTENT_SESSION_BOOTSTRAP DATABASE_URL DASHBOARD_DIR SOULSTREAM_PUBLIC_URL CORS_ALLOWED_ORIGINS AUTH_BEARER_TOKEN JWT_SECRET DASHBOARD_ADMIN_PASSWORD TAILSCALE_AUTH_ENABLED TAILSCALE_ALLOWED_LOGIN ATOM_ENABLED ATOM_SERVER_URL ATOM_PUBLIC_URL ATOM_API_KEY SKILL_CATALOG_NODE_ID DOMAIN_CATALOG_NODE_ID AGY_CLI_PATH'.split(' ');
const WORKER_KEYS = 'ENVIRONMENT SOULSTREAM_NODE_ID SOULSTREAM_UPSTREAM_URL SOULSTREAM_BACKENDS AUTH_BEARER_TOKEN JWT_SECRET PORTABLE_LOCAL_MCP_AUTHORIZATION HOST PORT MCP_INTERNAL_PORT MCP_ENABLED MCP_PATH MCP_REQUIRE_AUTH MCP_ALLOWED_HOSTS AGENTS_CONFIG_PATH AGENT_COMMON_FILES_DIR EVENT_OUTBOX_DIR INCOMING_FILE_DIR SOUL_RUNNER_PROCESS_ENABLED SOUL_RUNNER_STATE_DIR SOUL_RUNNER_ARTIFACT_DIR SOUL_RUNNER_RELEASES_DIR WORKTREE_MCP_ENABLED WORKTREE_PROJECTS_ROOT SESSION_ISOLATION_MODE CLAUDE_ACCOUNT_POOL_ENABLED ATOM_ENABLED ATOM_SERVER_URL ATOM_API_KEY CLAUDE_AUTH_TOKEN_PATH CODEX_ADAPTER_MODE CLAUDE_CODE_EXECPATH CODEX_CLI_PATH AGY_CLI_PATH DISABLE_AUTOUPDATER'.split(' ');
const WIN_AGENT_HOME_KEYS = ['CLAUDE_ACCOUNTS_DIR', 'CLAUDE_SHARED_HOME_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'];

const AGENTS_MD = `# Soulstream workspace

Use this shared workspace for your work. Create project worktrees under \`.projects/<repository>--<branch>\`.
Keep temporary scripts in \`.local/tmp\` and work products in \`.local/artifacts\`.
Scripts of shared and custom skills live under \`$AGENT_COMMON_FILES_DIR/skills/<skill>/\`.
The \`soulstream\` MCP server provides session and workspace tools.
The \`atom\` MCP server holds your instructions and skills. Rules live under \`에이전트 > 공통 > rules\` and skills under \`에이전트 > 공통 > skills\`.
Find skills with \`search_skills\` and read them with \`load_skill\`. Read any other atom node with \`compile_subtree\`.
`;

const MCP_PROFILES = `profiles:
  - id: default
    name: Default
    mcp_servers: [soulstream, atom]
  - id: pas
    name: PAS
    mcp_servers: [soulstream, atom]
`;

export function installDefaultsFromCatalog(catalogPath) {
  const line = readFileSync(catalogPath, 'utf8').split('\n').find((x) => x.startsWith('install_defaults: '));
  if (!line) throw new Error(`Cannot read install_defaults from model-catalog: ${catalogPath}`);
  const defaults = JSON.parse(line.slice('install_defaults: '.length));
  const values = [defaults?.backends?.claude, defaults?.backends?.codex, defaults?.backends?.antigravity, defaults?.profiles?.['card-orchestrator']];
  if (!values.every((v) => typeof v === 'string' && v.length > 0)) throw new Error(`Invalid install_defaults in model-catalog: ${catalogPath}`);
  return defaults;
}

// Seed names with a valid UUID; a value that is neither null nor a UUID is skipped with a warning.
export function readAtomSeedMap(mapPath) {
  let map;
  try { map = JSON.parse(readFileSync(mapPath, 'utf8')); } catch { map = null; }
  if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new Error(`Atom seed map is missing or invalid: ${mapPath}`);
  const nodes = {};
  const warnings = [];
  for (const name of ATOM_SEED_NAMES) {
    const value = map[name];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'string' && UUID_RE.test(value)) nodes[name] = value;
    else warnings.push(`atom seed map: ignored invalid value for ${name}`);
  }
  return { nodes, warnings };
}

export function readAtomApiKey(keyPath) {
  const key = existsSync(keyPath) ? readFileSync(keyPath, 'utf8').replace(/\n$/, '') : '';
  if (key === '') throw new Error(`Atom API key file is missing: ${keyPath}`);
  if (!ATOM_API_KEY_RE.test(key)) throw new Error('Atom API key has an unexpected format.');
  return key;
}

function atomContexts(nodes, items) {
  let out = '';
  for (const item of items) {
    const [name, depth] = [item.slice(0, item.indexOf(':')), item.slice(item.indexOf(':') + 1)];
    const node = nodes[name];
    if (!node) continue;
    out += depth === 'index'
      ? `      - node_id: ${node}\n        depth: 1\n        titles_only: false\n        mode: index\n`
      : `      - node_id: ${node}\n        depth: ${depth}\n        titles_only: false\n        include_ids: false\n`;
  }
  return out === '' ? '' : `    atom_contexts:\n${out}`;
}

export function renderAgents({ backends, defaults, nodes, workspace, root, path }) {
  const first = backends[0];
  const rules = BACKEND_RULES[first];
  const preset = (backend) => defaults.backends[backend];
  const portrait = (name) => path.join(root, 'install', 'assets', 'portraits', name);
  let out = 'agents:\n';
  out += `  - id: seosoyoung
    name: 서소영
    backend: ${first}
    default_preset: ${preset(first)}
    workspace_dir: ${workspace}
    disallowed_tools:
      - Workflow
      - ScheduleWakeup
      - AskUserQuestion
      - Skill
      - ReportFindings
      - ListAgents
    claude_auto_memory_enabled: false
    mcp_profile: default
    portrait_path: ${portrait('seosoyoung.png')}
`;
  out += atomContexts(nodes, ['common_rules:5', 'common_rules_extra:index', rules, 'seosoyoung_rules:5', 'seosoyoung_skills:1'].filter(Boolean));
  out += `  - id: seosoyoung-pas
    name: 서소영 (PAS)
    backend: ${first}
    default_preset: ${preset(first)}
    workspace_dir: ${workspace}
    disallowed_tools:
${PAS_DISALLOWED_TOOLS.map((tool) => `      - ${tool}\n`).join('')}    context_scope: minimal
    claude_auto_memory_enabled: false
    mcp_profile: pas
    portrait_path: ${portrait('seosoyoung-pas.png')}
`;
  out += atomContexts(nodes, ['common_rules:5', rules, 'seosoyoung_general:0', 'seosoyoung_rules_pas:5', 'seosoyoung_rules_extra_pas:index', 'seosoyoung_skills_pas:1'].filter(Boolean));
  if (backends.includes('claude')) {
    out += `  - id: card-orchestrator
    name: 카드 오케스트레이터
    backend: claude
    default_preset: ${defaults.profiles['card-orchestrator']}
    workspace_dir: ${workspace}
    context_scope: minimal
`;
    out += atomContexts(nodes, ['card_orchestrator_root:5']);
  }
  for (const backend of backends) {
    out += `  - id: ${backend}-default
    name: ${BACKEND_NAMES[backend]}
    backend: ${backend}
    default_preset: ${preset(backend)}
    workspace_dir: ${workspace}
    mcp_profile: default
`;
    out += atomContexts(nodes, ['common_rules:5', 'common_rules_extra:index', 'coding_common_rules:5', 'coding_common_rules_extra:0', BACKEND_RULES[backend]].filter(Boolean));
  }
  return out;
}

export function renderEnvFiles(o) {
  const { platform, home, root, workspace, path, ports, secrets, atomApiKey, backends, nodes } = o;
  const win = platform === 'win32';
  const orch = [
    'ENVIRONMENT=production',
    'HOST=127.0.0.1',
    `PORT=${ports.orch}`,
    'DEFAULT_EXECUTION_NODE_ID=local',
    'DEFAULT_PAS_AGENT_ID=seosoyoung-pas',
    'PERSISTENT_SESSION_BOOTSTRAP=true',
    `DATABASE_URL=postgresql://soulstream:${secrets.dbPassword}@127.0.0.1:${ports.postgres}/soulstream`,
    `DASHBOARD_DIR=${path.join(root, 'unified-dashboard', 'dist')}`,
    `AUTH_BEARER_TOKEN=${secrets.bearer}`,
    `JWT_SECRET=${secrets.jwt}`,
    'ATOM_ENABLED=true',
    `ATOM_SERVER_URL=http://127.0.0.1:${ports.atom}`,
    `ATOM_API_KEY=${atomApiKey}`,
    `SKILL_CATALOG_NODE_ID=${nodes.skill_catalog ?? ''}`,
    `DOMAIN_CATALOG_NODE_ID=${nodes.domain_catalog ?? ''}`,
    `SOULSTREAM_PUBLIC_URL=http://127.0.0.1:${ports.orch}`,
    `CORS_ALLOWED_ORIGINS=http://127.0.0.1:${ports.orch},http://localhost:${ports.orch}`,
    `ATOM_PUBLIC_URL=${o.atomDashboard === false ? '' : `http://127.0.0.1:${ports.atom}`}`,
    `DASHBOARD_ADMIN_PASSWORD=${secrets.adminPassword}`,
  ];
  if (!win && backends.includes('antigravity')) orch.push(`AGY_CLI_PATH=${home}/.local/bin/agy`);
  const worker = [
    'ENVIRONMENT=production',
    'SOULSTREAM_NODE_ID=local',
    `SOULSTREAM_UPSTREAM_URL=ws://127.0.0.1:${ports.orch}/ws/node`,
    `SOULSTREAM_BACKENDS=${backends.join(',')}`,
    `AUTH_BEARER_TOKEN=${secrets.bearer}`,
    `JWT_SECRET=${secrets.jwt}`,
    `PORTABLE_LOCAL_MCP_AUTHORIZATION="Bearer ${secrets.bearer}"`,
    'HOST=127.0.0.1',
    `PORT=${ports.worker}`,
    `MCP_INTERNAL_PORT=${ports.mcp}`,
    'MCP_ENABLED=true',
    'MCP_PATH=/mcp',
    'MCP_REQUIRE_AUTH=true',
    'MCP_ALLOWED_HOSTS=localhost,127.0.0.1',
    `AGENTS_CONFIG_PATH=${path.join(root, 'config', 'agents.yaml')}`,
    `AGENT_COMMON_FILES_DIR=${path.join(root, '.local', 'agent-common')}`,
    `EVENT_OUTBOX_DIR=${path.join(root, '.local', 'event-outbox')}`,
    `INCOMING_FILE_DIR=${path.join(root, '.local', 'incoming')}`,
    `SOUL_RUNNER_PROCESS_ENABLED=${win ? 'false' : 'true'}`,
    ...(win ? [] : [
      `SOUL_RUNNER_STATE_DIR=${path.join(root, '.local', 'r')}`,
      `SOUL_RUNNER_ARTIFACT_DIR=${path.join(root, 'soul-server-ts', 'dist', 'runner')}`,
      `SOUL_RUNNER_RELEASES_DIR=${path.join(root, '.local', 'runner-releases')}`,
    ]),
    'WORKTREE_MCP_ENABLED=true',
    `WORKTREE_PROJECTS_ROOT=${path.join(workspace, '.projects')}`,
    'SESSION_ISOLATION_MODE=off',
    'CLAUDE_ACCOUNT_POOL_ENABLED=true',
    'ATOM_ENABLED=true',
    `ATOM_SERVER_URL=http://127.0.0.1:${ports.atom}`,
    `ATOM_API_KEY=${atomApiKey}`,
  ];
  if (win) {
    // The Windows worker runs as the signed-in user, so its logins and session history live in agent-home and
    // the user's own ~/.claude, ~/.claude.json, ~/.claude-accounts and ~/.codex stay untouched.
    const { agentHome } = o;
    worker.push(
      `CLAUDE_ACCOUNTS_DIR=${path.join(agentHome, '.claude-accounts')}`,
      `CLAUDE_SHARED_HOME_DIR=${agentHome}`,
      `CLAUDE_CONFIG_DIR=${path.join(agentHome, '.claude')}`,
      `CLAUDE_AUTH_TOKEN_PATH=${path.join(agentHome, '.claude', '.credentials.json')}`,
      `CODEX_HOME=${path.join(agentHome, '.codex')}`,
    );
  } else if (backends.includes('claude')) {
    worker.push(`CLAUDE_AUTH_TOKEN_PATH=${path.join(home, '.claude', '.credentials.json')}`);
  }
  if (backends.includes('codex')) worker.push('CODEX_ADAPTER_MODE=app-server');
  return { orch, worker };
}

// Removes the keys the installer owns from the existing file, keeps every other line, and appends the new lines.
export function mergeEnv(target, freshLines, managedKeys, win) {
  const owned = new Set(managedKeys);
  let kept = '';
  if (existsSync(target)) {
    const lines = readFileSync(target, 'utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    kept = lines.filter((line) => !owned.has(line.replace(/=.*/s, ''))).map((line) => `${line}\n`).join('');
  }
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, kept + freshLines.map((line) => `${line}\n`).join(''), { mode: 0o600 });
  if (!win) chmodSync(temp, 0o600);
  renameSync(temp, target);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Writes new content unless you edited the file, then records the hashes. An edited file is kept and the new content
// goes to <file>.installer-new; its record line stays as it was.
function writeManaged(recordPath, items) {
  let record = '';
  if (existsSync(recordPath)) record = readFileSync(recordPath, 'utf8');
  const recordedFor = (file) => {
    for (const line of record.split('\n')) if (line.length > 66 && line.slice(66) === file) return line.slice(0, 64);
    return '';
  };
  let lines = '';
  const warnings = [];
  for (const { file, content } of items) {
    const recorded = recordedFor(file);
    const exists = existsSync(file);
    const current = exists ? readFileSync(file) : null;
    const same = exists && current.equals(Buffer.from(content));
    if (!exists || same || (recorded !== '' && sha256(current) === recorded)) {
      if (!same) writeFileSync(file, content);
      lines += `${sha256(Buffer.from(content))}  ${file}\n`;
    } else {
      writeFileSync(`${file}.installer-new`, content);
      warnings.push(`Kept your ${file}; the installer's version is in ${file}.installer-new.`);
      if (recorded !== '') lines += `${recorded}  ${file}\n`;
    }
  }
  writeFileSync(recordPath, lines, { mode: 0o644 });
  return warnings;
}

function linkClaudeMd({ platform, workspace, path, previousAgentsMd }) {
  const claude = path.join(workspace, 'CLAUDE.md');
  const agents = path.join(workspace, 'AGENTS.md');
  const exists = (() => { try { lstatSync(claude); return true; } catch { return false; } })();
  if (platform === 'win32') {
    // A copy, because a file symlink needs the symlink privilege on Windows.
    const next = readFileSync(agents);
    if (!exists || readFileSync(claude).equals(next) || (previousAgentsMd !== null && readFileSync(claude).equals(previousAgentsMd))) {
      copyFileSync(agents, claude);
      return [];
    }
    return [`Kept your ${claude}.`];
  }
  const link = exists && lstatSync(claude).isSymbolicLink() ? readlinkSync(claude) : null;
  if (!exists || link === 'AGENTS.md' || link === agents) {
    rmSync(claude, { force: true });
    symlinkSync('AGENTS.md', claude);
    return [];
  }
  return [`Kept your ${claude}.`];
}

// Copies the bundled skill scripts into the shared folder. Files the user added there are kept; files with the same
// path as a bundled file are replaced on every run.
function syncCommonFiles(root, path) {
  const source = path.join(root, 'install', 'common-files');
  if (!existsSync(source)) throw new Error(`Missing bundled skill scripts: ${source}`);
  const target = path.join(root, '.local', 'agent-common');
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
}

/**
 * options: platform, home (user home), root (soulstream checkout), workspace, agentHome (win32: the folder that holds
 * the worker's own Claude and Codex logins), backends (array), ports
 * {orch, atom, worker, mcp, postgres}, secrets {bearer, jwt, dbPassword, adminPassword}, atomDashboard (false leaves
 * ATOM_PUBLIC_URL empty so the dashboard shows no atom link). Returns { warnings, seedWarnings }.
 */
export function renderConfig(options) {
  const platform = options.platform;
  const path = platform === 'win32' ? win32 : posix;
  const { home, root, backends } = options;
  const workspace = options.workspace ?? path.join(home, 'workspace');
  const defaults = installDefaultsFromCatalog(path.join(root, 'packages', 'model-catalog', 'data', 'model-catalog.yaml'));
  const { nodes, warnings: seedWarnings } = readAtomSeedMap(path.join(root, 'config', '.atom-seed-map.json'));
  const atomApiKey = readAtomApiKey(path.join(root, '.atom-api-key'));
  mkdirSync(path.join(root, 'config'), { recursive: true });
  mkdirSync(path.join(workspace, '.projects'), { recursive: true });
  mkdirSync(path.join(workspace, '.local', 'tmp'), { recursive: true });
  mkdirSync(path.join(workspace, '.local', 'artifacts'), { recursive: true });
  syncCommonFiles(root, path);
  const o = { ...options, platform, path, workspace, nodes, atomApiKey };
  const env = renderEnvFiles(o);
  const win = platform === 'win32';
  mergeEnv(path.join(root, '.env.orch'), env.orch, ORCH_KEYS, win);
  mergeEnv(path.join(root, '.env.soul-server-ts'), env.worker, win ? [...WORKER_KEYS, ...WIN_AGENT_HOME_KEYS] : WORKER_KEYS, win);
  const agentsMdPath = path.join(workspace, 'AGENTS.md');
  const previousAgentsMd = existsSync(agentsMdPath) ? readFileSync(agentsMdPath) : null;
  const warnings = writeManaged(path.join(root, 'config', '.installer-managed.sha256'), [
    { file: path.join(root, 'config', 'agents.yaml'), content: renderAgents({ backends, defaults, nodes, workspace, root, path }) },
    {
      file: path.join(root, 'config', 'mcp-registry.yaml'),
      content: `servers:
  - id: soulstream
    type: streamable_http
    url: http://127.0.0.1:${options.ports.worker}/mcp
    headers:
      Authorization:
        env: PORTABLE_LOCAL_MCP_AUTHORIZATION
  - id: atom
    type: streamable_http
    url: http://127.0.0.1:${options.ports.atom}/mcp
    headers:
      x-api-key:
        env: ATOM_API_KEY
`,
    },
    { file: path.join(root, 'config', 'mcp-profiles.yaml'), content: MCP_PROFILES },
    { file: agentsMdPath, content: AGENTS_MD },
  ]);
  warnings.push(...linkClaudeMd({ platform, workspace, path, previousAgentsMd }));
  return { warnings, seedWarnings };
}

// The value rule of install.sh validate_admin_password.
export const PASSWORD_RULE_MESSAGE = 'Invalid administrator password: use 8 to 128 printable ASCII characters on a single line, with no leading or trailing space and none of # \\ \' " `';
export function validateAdminPassword(password) {
  return /^[\x20-\x7e]{8,128}$/.test(password) && !/^ | $/.test(password) && !/[#\\'"`]/.test(password);
}
