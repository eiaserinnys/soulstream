// Secrets, PostgreSQL roles and databases, and the schema, in the order of install.sh.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, log, readEnvValue, run } from './lib.mjs';
import { PASSWORD_RULE_MESSAGE, validateAdminPassword } from './render_config.mjs';

const hex = (bytes) => randomBytes(bytes).toString('hex');

export function readExistingAdminPassword(ctx) {
  const saved = join(ctx.soulDir, '.admin-password');
  if (existsSync(saved)) {
    const value = readFileSync(saved, 'utf8').replace(/\r?\n$/, '');
    if (value !== '') return value;
  }
  return readEnvValue(join(ctx.soulDir, '.env.orch'), 'DASHBOARD_ADMIN_PASSWORD') || readEnvValue(join(ctx.atomDir, '.env'), 'DASHBOARD_ADMIN_PASSWORD');
}

// Keeps every secret an earlier run wrote and generates only what is missing; the administrator password
// is the one of --admin-password-file when given. Writes <soulstream>/.admin-password, the only copy besides the env files.
export function prepareSecrets(ctx, adminPasswordFile) {
  const orchEnv = join(ctx.soulDir, '.env.orch');
  const databaseUrl = readEnvValue(orchEnv, 'DATABASE_URL');
  const fromUrl = /^postgresql:\/\/soulstream:([^@]+)@/.exec(databaseUrl)?.[1] ?? '';
  const secrets = {
    bearer: readEnvValue(orchEnv, 'AUTH_BEARER_TOKEN') || hex(32),
    jwt: readEnvValue(orchEnv, 'JWT_SECRET') || hex(32),
    dbPassword: fromUrl || hex(32),
    atomJwt: readEnvValue(join(ctx.atomDir, '.env'), 'JWT_SECRET') || hex(32),
    adminPassword: '',
    adminPasswordIsNew: false,
  };
  if (adminPasswordFile) {
    secrets.adminPassword = readFileSync(adminPasswordFile, 'utf8').replace(/\r?\n$/, '');
    if (!validateAdminPassword(secrets.adminPassword)) throw fail(PASSWORD_RULE_MESSAGE);
  } else {
    secrets.adminPassword = readExistingAdminPassword(ctx);
    if (secrets.adminPassword === '') {
      secrets.adminPassword = hex(12);
      secrets.adminPasswordIsNew = true;
    }
  }
  mkdirSync(ctx.soulDir, { recursive: true });
  const temp = join(ctx.soulDir, `.admin-password.${process.pid}`);
  writeFileSync(temp, `${secrets.adminPassword}\n`, { mode: 0o600 });
  renameSync(temp, join(ctx.soulDir, '.admin-password'));
  return secrets;
}

const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;

export function psql(ctx, args, { input, db = 'postgres', vars = [] } = {}) {
  const command = ctx.pgBin ? join(ctx.pgBin, ctx.platform === 'win32' ? 'psql.exe' : 'psql') : 'psql';
  return run(command, [
    '-h', '127.0.0.1', '-p', String(ctx.ports.postgres), '-U', 'postgres', '-d', db, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
    ...vars.flatMap((v) => ['-v', v]), ...args,
  ], { input, capture: true, env: { PGPASSWORD: ctx.postgresPassword }, label: 'psql' });
}

export function setupDatabases(ctx, secrets) {
  const roleExists = psql(ctx, ['-c', "SELECT 1 FROM pg_roles WHERE rolname='soulstream'"]).trim() === '1';
  const verb = roleExists ? 'ALTER' : 'CREATE';
  psql(ctx, [], { input: `${verb} ROLE soulstream LOGIN PASSWORD ${sqlLiteral(secrets.dbPassword)};\n` });
  for (const name of ['soulstream', 'atom']) {
    const exists = psql(ctx, ['-c', `SELECT 1 FROM pg_database WHERE datname='${name}'`]).trim() === '1';
    if (!exists) psql(ctx, ['-c', `CREATE DATABASE ${name} OWNER soulstream`]);
  }
}

export function atomSchemaReady(ctx) {
  const answer = psql(ctx, ['-c', "SELECT current_database() = 'atom' AND to_regclass('public.cards') IS NOT NULL AND to_regclass('public.agents') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'scope')"], { db: 'atom' });
  return answer.trim() === 't';
}

// A first install initializes the schema. A rerun asks the same tool to reconcile; a database that is behind the
// checked-out source is not upgraded here, because the upgrade belongs to the Haniel database release.
export function setupSchema(ctx, secrets) {
  const head = run('git', ['-C', ctx.soulDir, 'rev-parse', 'HEAD'], { capture: true }).trim();
  const release = `clean-${head.slice(0, 12)}`;
  const env = {
    DATABASE_URL: `postgresql://soulstream:${secrets.dbPassword}@127.0.0.1:${ctx.ports.postgres}/soulstream`,
    SOULSTREAM_RELEASE_ID: release,
    HANIEL_BACKUP_DIR: join(ctx.soulDir, '.local', 'database-release', release),
  };
  const populated = psql(ctx, ['-c', "SELECT to_regclass('public.users') IS NOT NULL"], { db: 'soulstream' }).trim() === 't';
  const mode = populated ? 'initialize' : 'fresh-install';
  const migrate = join('packages', 'db-schema', 'scripts', 'migrate.mjs');
  log(`Database schema: ${mode}`);
  try {
    run(process.execPath, [migrate, mode], { cwd: ctx.soulDir, env, capture: true, label: `migrate ${mode}` });
  } catch (error) {
    if (String(error.message).includes('UPGRADE_REQUIRES_HANIEL_HANDOVER')) {
      throw fail('The soulstream database is behind this version and the Windows installer does not upgrade it. Remove the installation with uninstall-windows.ps1 and install again, or install the version that matches the existing database.');
    }
    throw error;
  }
  run(process.execPath, [migrate, 'verify'], { cwd: ctx.soulDir, env, capture: true, label: 'migrate verify' });
  psql(ctx, [], {
    db: 'soulstream',
    vars: ['owner=owner@local', 'display_name=Owner'],
    input: "INSERT INTO users (email, display_name, is_admin) VALUES (:'owner', :'display_name', TRUE) ON CONFLICT (email) DO NOTHING;\n",
  });
}
