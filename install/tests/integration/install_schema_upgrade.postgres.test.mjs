// The installer's real schema step against a real PostgreSQL server: install.sh is sourced and
// setup_schema, backup_database and on_error run as they are, with the release executor and
// migrate.mjs from a copy of this repository. Only the outside is replaced: as_soul runs as the test
// user, sudo -u postgres reaches the TEST_DATABASE_URL server as its administrator, and systemctl is
// a fake that holds unit states (helpers/installer_postgres.mjs, helpers/systemctl_preload.cjs).
//
// The executor only migrates a database named soulstream, so the test creates one on the test server,
// with the role soulstream that owns it as on an installed server, and drops both at the end. It stops
// before touching anything if the server already has a soulstream database or role it did not create.
//
// Without TEST_DATABASE_URL this file fails in CI and is skipped elsewhere.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBash } from '../support/fake_commands.mjs';
import { adminSql, clientMajor, readTestServer, writeCommands } from './helpers/installer_postgres.mjs';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const script = join(repository, 'install', 'install.sh');
const preload = fileURLToPath(new URL('./helpers/systemctl_preload.cjs', import.meta.url));
const url = process.env.TEST_DATABASE_URL?.trim() ?? '';
const ci = !['', '0', 'false'].includes((process.env.CI ?? '').trim().toLowerCase());
const skip = !url && !ci ? 'TEST_DATABASE_URL is not set; CI runs this file against its PostgreSQL service' : false;
if (skip) process.stdout.write(`# ${skip}\n`);

const MARKER = 'install_schema_upgrade.postgres.test.mjs';
const OWNER_PASSWORD = 'installer_owner_secret';
const RESTORE_DATABASE = 'installer_restore_test';
const UNITS = ['soulstream-worker.service', 'soulstream-orch.service', 'soulstream-atom.service'];
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } }).trim();
// Runs the schema step the way run_install does once maintenance has started.
const SCHEMA_STEP = `set -Eeuo pipefail
source "$INSTALL_SH"
as_soul() { "$@"; }
SYSTEMD_DIR=$INSTALLER_TEST_SYSTEMD_DIR
LOG=$CASE_DIR/install-$RUN.log
: >> "$LOG"
exec 3>>"$CASE_DIR/fd3-$RUN.log"
parse_args
INSTALL_ROOT=$ROOT
REPO_PATH[soulstream]=$ROOT; REPO_PREVIOUS[soulstream]=$PREVIOUS; REPO_TARGET[soulstream]=$TARGET
MAINTENANCE_ENTERED=true
trap on_error ERR
run_step 'Initializing schema' setup_schema "$ROOT"
write_install_state "$ROOT" completed "$STEP" >> "$LOG" 2>&1
`;
// Back to the 171 schema with user rows: the 173 tables gone, the 172 transcript store present.
const AT_171 = `SET ROLE soulstream;
DELETE FROM schema_migrations
 WHERE ordinal >= (SELECT ordinal FROM schema_migrations WHERE migration_id = '172_drop_claude_transcript_store.sql');
DROP TABLE mcp_agent_bindings, mcp_server_icons, mcp_config_revisions, mcp_profiles,
  mcp_servers, mcp_secrets, mcp_managed_nodes, mcp_config_state;
CREATE TABLE claude_transcript_entries (
    id          BIGSERIAL PRIMARY KEY,
    project_key TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    subpath     TEXT NOT NULL DEFAULT '',
    entry_uuid  TEXT,
    entry       JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO claude_transcript_entries (project_key, session_id, entry) VALUES ('installer', 'session-1', '{}'::jsonb);
INSERT INTO folders (id, name) VALUES ('installer-folder', 'Installer folder');
INSERT INTO cards (id, folder_id, position_key, title) VALUES ('installer-card', 'installer-folder', 'a0', 'Installer card');
`;

let server, pgBin, work, ownsRole = false;
const sql = (database, text) => adminSql(server, pgBin, work, database, text);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

// '' when absent, the comment (or <none>) when present.
const sharedComment = (catalog, table, column, name) => sql(server.database,
  `SELECT coalesce(shobj_description(oid, '${catalog}'), '<none>') FROM ${table} WHERE ${column} = ${quote(name)};`);

function dropOwnDatabase(name) {
  const comment = sharedComment('pg_database', 'pg_database', 'datname', name);
  if (comment === '') return;
  if (comment !== MARKER) throw new Error(`the test server already has a database ${name}; refusing to touch it`);
  sql(server.database, `DROP DATABASE ${name} WITH (FORCE);`);
}
function createOwnDatabase(name) {
  dropOwnDatabase(name);
  sql(server.database, `CREATE DATABASE ${name} OWNER soulstream;\nCOMMENT ON DATABASE ${name} IS ${quote(MARKER)};`);
}

describe('the installer schema step on PostgreSQL', { skip }, () => {
  before(() => {
    if (!url) throw new Error('TEST_DATABASE_URL is required in CI');
    server = readTestServer(url);
    pgBin = process.env.PG_BIN_DIR?.trim() || dirname(execFileSync('bash', ['-c', 'command -v pg_dump'], { encoding: 'utf8' }).trim());
    work = mkdtempSync(join(tmpdir(), 'install-schema-pg-'));
    const serverMajor = Math.floor(Number(sql(server.database, 'SHOW server_version_num;')) / 10000);
    for (const name of ['psql', 'pg_dump', 'pg_restore']) {
      assert.equal(clientMajor(pgBin, name), serverMajor, `${pgBin}/${name} must match the server's major version`);
    }
    for (const name of ['soulstream', RESTORE_DATABASE]) {
      const comment = sharedComment('pg_database', 'pg_database', 'datname', name);
      if (comment !== '' && comment !== MARKER) throw new Error(`the test server already has a database ${name}; refusing to run`);
    }
    const role = sharedComment('pg_authid', 'pg_roles', 'rolname', 'soulstream');
    if (role !== '' && role !== MARKER) throw new Error('the test server already has a role soulstream; refusing to run');
    sql(server.database, `${role === '' ? 'CREATE' : 'ALTER'} ROLE soulstream LOGIN PASSWORD ${quote(OWNER_PASSWORD)};\nCOMMENT ON ROLE soulstream IS ${quote(MARKER)};`);
    ownsRole = true;
  });

  after(() => {
    try {
      if (ownsRole) {
        dropOwnDatabase('soulstream');
        dropOwnDatabase(RESTORE_DATABASE);
        sql(server.database, 'DROP ROLE soulstream;');
      }
    } finally {
      if (work) rmSync(work, { recursive: true, force: true });
    }
  });

  // A fresh soulstream database and a repository copy whose commits are the installer's revisions.
  function newCase(name) {
    const dir = join(work, name), root = join(dir, 'soulstream'), bin = join(dir, 'bin');
    const systemd = join(dir, 'systemd'), units = join(dir, 'units');
    for (const path of [bin, systemd, units, join(root, 'install')]) mkdirSync(path, { recursive: true });
    cpSync(join(repository, 'packages', 'db-schema'), join(root, 'packages', 'db-schema'), {
      recursive: true, filter: (source) => !source.split('/').includes('node_modules'),
    });
    for (const file of ['release-manifest-installer.json', 'database-release-installer.json']) {
      cpSync(join(repository, 'install', file), join(root, 'install', file));
    }
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'));
    symlinkSync(join(repository, 'packages', 'db-schema', 'node_modules'), join(root, 'packages', 'db-schema', 'node_modules'));
    writeFileSync(join(root, '.gitignore'), 'node_modules\n.env.orch\n.local/\n');
    git('init', '-q', '--initial-branch=main', root);
    git('-C', root, 'add', '-A');
    git('-C', root, 'commit', '-q', '-m', 'revision 1');
    writeFileSync(join(root, '.env.orch'),
      `DATABASE_URL=postgresql://soulstream:${OWNER_PASSWORD}@${server.host.includes(':') ? `[${server.host}]` : server.host}:${server.port}/soulstream\n`,
      { mode: 0o600 });
    writeCommands(bin);
    createOwnDatabase('soulstream');

    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|HANIEL_|NODE_OPTIONS$|DATABASE_URL$|MIGRATION_DATABASE_URL$|TEST_DATABASE_URL$)/.test(key))),
      ...GIT_ENV,
      PATH: `${bin}:${process.env.PATH}`,
      NODE_OPTIONS: `--require ${preload}`,
      INSTALL_SH: script, ROOT: root, CASE_DIR: dir,
      INSTALLER_TEST_SYSTEMCTL: join(bin, 'systemctl'), INSTALLER_TEST_SYSTEMD_DIR: systemd, INSTALLER_TEST_UNITS: units,
      INSTALLER_TEST_HOME: dir, INSTALLER_TEST_PG_BIN: pgBin, INSTALLER_TEST_PGHOST: server.host, INSTALLER_TEST_PGPORT: server.port,
      INSTALLER_TEST_PGUSER: server.user, INSTALLER_TEST_PGPASSWORD: server.password,
    };
    const head = () => git('-C', root, 'rev-parse', 'HEAD');
    const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
    const backups = join(root, '.local', 'backups');
    return {
      root, env,
      head,
      commit: () => { git('-C', root, 'commit', '-q', '--allow-empty', '-m', 'next revision'); return head(); },
      // RUN names the log and fd 3 files of one run; previous and target are the commits check_repositories recorded.
      run: (run, previous, target) => runBash(SCHEMA_STEP, [], { env: { ...env, RUN: run, PREVIOUS: previous, TARGET: target }, timeout: 240_000 }),
      bash: (command) => runBash(command, [], { env, timeout: 120_000 }),
      fd3: (run) => read(join(dir, `fd3-${run}.log`)),
      log: (run) => read(join(dir, `install-${run}.log`)),
      state: () => JSON.parse(readFileSync(join(root, '.local', 'install-state.json'), 'utf8')),
      journal: (target) => JSON.parse(readFileSync(join(root, '.local', 'database-release', `clean-${target.slice(0, 12)}`, 'database-release.json'), 'utf8')),
      backups,
      dumps: () => (existsSync(backups) ? readdirSync(backups).filter((file) => /^soulstream-\d{8}T\d{6}Z-.+\.pgdump$/.test(file)).sort() : []),
      // Unit files make the units loaded; the state files hold "ActiveState MainPID".
      units: (states) => {
        for (const [unit, value] of Object.entries(states)) {
          writeFileSync(join(systemd, unit), '[Unit]\n');
          writeFileSync(join(units, unit), `${value}\n`);
        }
      },
      unitState: (unit) => read(join(units, unit)).trim(),
      startOnShow: (unit, count) => writeFileSync(join(units, 'start-on-show'), `${unit} ${count}\n`),
      systemctlCalls: () => read(join(units, 'calls.log')),
    };
  }
  const ledger = () => sql('soulstream', `SELECT string_agg(migration_id || ' ' || release_id, ',' ORDER BY ordinal) FROM schema_migrations WHERE migration_id IN ('172_drop_claude_transcript_store.sql', '173_mcp_central_config.sql');`);
  const userRows = (database) => sql(database, "SELECT (SELECT count(*) FROM folders WHERE id = 'installer-folder') || ' ' || (SELECT count(*) FROM cards WHERE id = 'installer-card');");
  const transcriptStore = (database) => sql(database, "SELECT coalesce(to_regclass('public.claude_transcript_entries')::text, 'absent');");
  const expected = (target) => `172_drop_claude_transcript_store.sql clean-${target.slice(0, 12)},173_mcp_central_config.sql clean-${target.slice(0, 12)}`;

  // Installs the first revision on the empty database, then takes it back to 171 with user rows.
  async function installedAt171(c) {
    const first = c.head();
    const install = await c.run('install', '', first);
    assert.equal(install.status, 0, c.fd3('install') + c.log('install'));
    sql('soulstream', AT_171);
    return first;
  }

  test('a first installation on an empty database creates the schema and takes no dump', async () => {
    const c = newCase('fresh');
    const target = c.head();
    const result = await c.run('fresh', '', target);
    assert.equal(result.status, 0, c.fd3('fresh') + c.log('fresh'));
    assert.equal(c.journal(target).operation, 'fresh_install');
    assert.equal(c.journal(target).status, 'verified');
    assert.deepEqual(c.dumps(), []);
    assert.deepEqual(c.state().backups, {});
    assert.equal(sql('soulstream', "SELECT count(*) FROM users WHERE email = 'owner@local';"), '1');
    // A first installation needs no stop check, so no unit state is read.
    assert.equal(c.systemctlCalls(), '');
  });

  test('a non-additive upgrade dumps soulstream once, restores from that dump, and a same-target rerun adds none', async () => {
    const c = newCase('upgrade');
    const previous = await installedAt171(c);
    const target = c.commit();
    c.units({ 'soulstream-orch.service': 'inactive 0', 'soulstream-worker.service': 'inactive 0', 'soulstream-atom.service': 'active 4100' });

    const upgrade = await c.run('upgrade', previous, target);
    assert.equal(upgrade.status, 0, c.fd3('upgrade') + c.log('upgrade'));
    const [dump] = c.dumps();
    assert.deepEqual(c.dumps(), [dump]);
    assert.match(dump, new RegExp(`^soulstream-\\d{8}T\\d{6}Z-${previous.slice(0, 12)}-to-${target.slice(0, 12)}\\.pgdump$`));
    const path = join(c.backups, dump);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(c.backups).mode & 0o777, 0o700);
    assert.equal(c.state().backups.soulstream.path, path);
    // The executor read both units through the fake, at apply start and inside its lock.
    for (const unit of ['soulstream-orch.service', 'soulstream-worker.service']) {
      assert.equal(c.systemctlCalls().split('\n').filter((line) => line.startsWith('show ') && line.endsWith(` ${unit}`)).length, 2, c.systemctlCalls());
    }
    assert.equal(ledger(), expected(target));
    assert.equal(userRows('soulstream'), '1 1');
    assert.equal(transcriptStore('soulstream'), 'absent');

    createOwnDatabase(RESTORE_DATABASE);
    const restore = c.state().backups.soulstream.restore_command.replace('<empty_database>', RESTORE_DATABASE);
    const restored = await c.bash(restore);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(userRows(RESTORE_DATABASE), '1 1');
    assert.equal(sql(RESTORE_DATABASE, 'SELECT count(*) FROM claude_transcript_entries;'), '1');

    const again = await c.run('again', target, target);
    assert.equal(again.status, 0, c.fd3('again') + c.log('again'));
    assert.deepEqual(c.dumps(), [dump]);
    assert.deepEqual(c.state().backups, {});
  });

  // A unit that starts during apply is caught by the executor's check inside its lock, so the
  // migration transaction rolls back and the database is as it was when the dump was taken.
  test('a failed apply leaves the services stopped, reports the dump in stderr and the state file, and the same command then completes', async () => {
    const c = newCase('failure');
    const previous = await installedAt171(c);
    const target = c.commit();
    c.units({ 'soulstream-orch.service': 'inactive 0', 'soulstream-worker.service': 'inactive 0', 'soulstream-atom.service': 'active 4100' });
    c.startOnShow('soulstream-orch.service', 2);

    const failed = await c.run('failed', previous, target);
    assert.equal(failed.status, 1, c.log('failed'));
    const fd3 = c.fd3('failed');
    assert.ok(fd3.includes('Installation failed at: Initializing schema\n'), fd3);
    assert.ok(fd3.includes('Database release apply failed: APPLY_FAILED\n'), fd3);
    assert.ok(fd3.includes('Services stopped: soulstream-worker=inactive soulstream-orch=inactive soulstream-atom=inactive\n'), fd3);
    for (const unit of UNITS) assert.equal(c.unitState(unit), 'inactive 0', unit);
    const [dump] = c.dumps();
    const path = join(c.backups, dump);
    const state = c.state();
    assert.equal(state.status, 'failed');
    assert.equal(state.step, 'Initializing schema');
    assert.deepEqual(state.units, Object.fromEntries(UNITS.map((unit) => [unit, 'inactive'])));
    assert.equal(state.backups.soulstream.path, path);
    assert.ok(fd3.includes(`Database backup (soulstream): ${path}\n`), fd3);
    assert.ok(fd3.includes(`${state.backups.soulstream.restore_command}\n`), fd3);
    assert.ok(state.backups.soulstream.restore_command.endsWith(`< '${path}'`));
    assert.equal(c.journal(target).status, 'apply_failed');
    assert.equal(ledger(), '');
    assert.equal(transcriptStore('soulstream'), 'claude_transcript_entries');

    const retry = await c.run('retry', target, target);
    assert.equal(retry.status, 0, c.fd3('retry') + c.log('retry'));
    assert.equal(c.journal(target).status, 'verified');
    assert.equal(ledger(), expected(target));
    assert.equal(userRows('soulstream'), '1 1');
    assert.equal(c.dumps().length, 2);
  });
});
