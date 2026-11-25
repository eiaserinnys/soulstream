// install/uninstall.sh against a temporary server.
//
// Nothing here touches this host. uninstall.sh is sourced and run_uninstall gets temporary roots; PATH holds
// only the fake commands in support/uninstall-fakes/ and symlinks to ordinary tools (see support/uninstall_env.mjs),
// so the real systemctl, psql, sudo, userdel, pkill, pgrep, crontab and tailscale cannot be reached. The fake
// user has uid 4242424, which this host does not have.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  FAKE_UID, SECRET, UNITS, createSandbox, installedServer, indexOfCall, installScript, listTree, ownerTable, ptyUninstall, runBash,
  runUninstall, scriptPath, serveConfig, setOwner, uninstallScript, writeFile,
} from './support/uninstall_env.mjs';
import { assertHostUntouched, snapshotHost } from './support/host_guard.mjs';

const hostBefore = snapshotHost();
const present = (path) => { try { lstatSync(path); return true; } catch { return false; } };
const nonSudo = (calls) => calls.filter((line) => !line.startsWith('sudo '));

// Runs `body` on a fresh sandbox holding a clean install (or the variant in `options`).
async function withServer(options, body) {
  const sandbox = createSandbox();
  try {
    installedServer(sandbox, options);
    await body(sandbox);
  } finally { sandbox.cleanup(); }
}
const writeState = (sandbox, name, body) => writeFileSync(join(sandbox.dir, name), body);
const productPaths = (s) => [s.home, s.log, s.receipt, ...UNITS.map((unit) => join(s.systemd, unit)), ...UNITS.map((unit) => join(s.systemd, 'multi-user.target.wants', unit)),
  join(s.usrLocal, 'bin', 'node'), join(s.usrLocal, 'bin', 'codex'), join(s.usrLocal, 'bin', 'pnpm'), join(s.usrLocal, 'lib', 'node_modules', 'npm')];
const neighbours = (s) => [join(s.systemd, 'other.service'), join(s.usrLocal, 'bin', 'other-tool'), join(s.usrLocal, 'lib', 'python3', 'keep.txt')];
const failedSection = (stdout) => (stdout.includes('\nFailed:\n') ? stdout.slice(stdout.indexOf('\nFailed:\n')) : '');
const serveRoots = (s) => JSON.parse(readFileSync(join(s.dir, 'serve.json'), 'utf8')).Web;

// What nothing past the services gate may touch.
const GATED = [/^pkill /, /^pgrep /, /^crontab /, /^userdel /, /DROP /];

test('arguments: --yes and --help are accepted, everything else stops with usage and exit 2', async () => {
  const sandbox = createSandbox();
  try {
    const help = await runBash(sandbox, 'source "$UNINSTALL_SH"; parse_args "$@"; printf "after\\n"', ['--help']);
    assert.equal(help.status, 0);
    assert.equal(help.stdout, 'Usage: uninstall.sh [--yes] [--help]\n');
    const yes = await runBash(sandbox, 'source "$UNINSTALL_SH"; parse_args "$@"; printf "%s\\n" "$ASSUME_YES"', ['--yes']);
    assert.equal(yes.stdout, 'true\n');
    const none = await runBash(sandbox, 'source "$UNINSTALL_SH"; parse_args "$@"; printf "%s\\n" "$ASSUME_YES"', []);
    assert.equal(none.stdout, 'false\n');
    for (const bad of [['--force'], ['--keep-db'], ['somewhere'], ['--yes', '--force'], ['--yes=1']]) {
      const result = await runBash(sandbox, 'source "$UNINSTALL_SH"; parse_args "$@"; printf "after\\n"', bad);
      assert.equal(result.status, 2, bad.join(' '));
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Usage: uninstall.sh [--yes] [--help]\n');
    }
    assert.deepEqual(sandbox.calls(), []);
  } finally { sandbox.cleanup(); }
});

test('the script file: sourcing runs nothing, a pipe reaches main, a bad argument or --help exits before any check', async () => {
  const sandbox = createSandbox();
  try {
    const sourced = await runBash(sandbox, 'source "$UNINSTALL_SH"');
    assert.deepEqual([sourced.status, sourced.stdout, sourced.stderr], [0, '', '']);
    const piped = await runBash(sandbox, 'cat "$UNINSTALL_SH" | bash -s -- --help');
    assert.deepEqual([piped.status, piped.stdout], [0, 'Usage: uninstall.sh [--yes] [--help]\n']);
    const pipedBad = await runBash(sandbox, 'cat "$UNINSTALL_SH" | bash -s -- --bogus');
    assert.equal(pipedBad.status, 2);
    const direct = await runBash(sandbox, 'bash "$UNINSTALL_SH" "$@"', ['--help']);
    assert.equal(direct.status, 0);
    const directBad = await runBash(sandbox, 'bash "$UNINSTALL_SH" "$@"', ['--force']);
    assert.equal(directBad.status, 2);
    assert.deepEqual(sandbox.calls(), []);
    // main without root stops with this message. A test run as root must not call main, so only a non-root run checks it.
    if (process.getuid() !== 0) {
      const refused = await runBash(sandbox, 'bash "$UNINSTALL_SH"');
      assert.equal(refused.status, 1);
      assert.equal(refused.stderr, 'Run again with sudo.\n');
      assert.deepEqual(sandbox.calls(), []);
    }
  } finally { sandbox.cleanup(); }
});

test('the script names no service env file and never uses status --json, serve reset or DROP OWNED', () => {
  const text = readFileSync(uninstallScript, 'utf8');
  assert.doesNotMatch(text, /\.env/);
  assert.doesNotMatch(text, /tailscale status/);
  assert.doesNotMatch(text, /serve reset/);
  assert.doesNotMatch(text, /DROP OWNED/);
});

test('a clean install is removed in order: units, processes, Serve, databases, /usr/local, account, log and receipt', async () => {
  await withServer({}, async (s) => {
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const path of productPaths(s)) assert.equal(present(path), false, path);
    for (const path of neighbours(s)) assert.equal(present(path), true, path);
    assert.equal(present(join(s.dir, 'etc', 'soulstream')), false);
    assert.match(result.stdout, /^Removed:$/m);
    assert.match(result.stdout, /^Kept:$/m);
    assert.doesNotMatch(result.stdout, /^Failed:$/m);
    assert.match(result.stdout, /tailscale logout/);
    const calls = nonSudo(s.calls());
    const order = [
      'systemctl stop soulstream-worker.service', 'systemctl stop soulstream-orch.service', 'systemctl stop soulstream-atom.service',
      'systemctl is-active soulstream-worker.service', 'systemctl is-active soulstream-orch.service', 'systemctl is-active soulstream-atom.service',
      'systemctl disable soulstream-worker.service', 'systemctl disable soulstream-orch.service', 'systemctl disable soulstream-atom.service',
      'systemctl daemon-reload', 'systemctl reset-failed soulstream-worker.service soulstream-orch.service soulstream-atom.service',
      'crontab -u soulstream -r', `pgrep -u ${FAKE_UID}`,
      'tailscale serve --https=443 --set-path=/ off', 'tailscale serve --https=8443 --set-path=/ off', 'tailscale serve status --json',
      'psql -X -Atq -v ON_ERROR_STOP=1 -c DROP DATABASE "soulstream" WITH (FORCE);', 'psql -X -Atq -v ON_ERROR_STOP=1 -c DROP DATABASE "atom" WITH (FORCE);',
      'psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -c DROP ROLE soulstream;',
      'userdel -r soulstream',
    ];
    let at = -1;
    for (const marker of order) {
      const found = indexOfCall(calls, marker, at + 1);
      assert.ok(found > at, `${marker} did not follow the previous step`);
      at = found;
    }
    // /usr/local was already empty of the installer's tools when the account was removed.
    assert.ok(calls.includes('userdel-saw node=absent codex=absent'));
    // No process was signalled: none was running.
    assert.equal(s.called('pkill '), false);
    assert.equal(calls.some((line) => /serve reset|tailscale status|tailscale logout/.test(line)), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes(SECRET), false);
  });
});

test('every unit state other than inactive or failed holds back the dependent steps, but Serve and the log still go', async () => {
  for (const state of ['active', 'activating', 'reloading', 'deactivating', 'unknown', '@empty', '@fail', 'maintenance']) {
    await withServer({}, async (s) => {
      const result = await runUninstall(s, ['--yes'], { extra: { FAKE_IS_ACTIVE: `soulstream-orch.service=${state}` } });
      const label = `unit state ${state}`;
      assert.equal(result.status, 1, label);
      assert.match(failedSection(result.stdout), /soulstream-orch\.service: not confirmed stopped/, label);
      assert.match(failedSection(result.stdout), /Skipped \(services not confirmed stopped\)/, label);
      const calls = nonSudo(s.calls());
      for (const pattern of GATED) assert.equal(calls.some((line) => pattern.test(line)), false, `${label}: ${pattern}`);
      assert.equal(calls.some((line) => /^systemctl (disable|daemon-reload)/.test(line)), false, label);
      for (const path of [s.home, s.receipt, join(s.usrLocal, 'bin', 'node'), join(s.usrLocal, 'bin', 'codex'), ...UNITS.map((unit) => join(s.systemd, unit))]) assert.equal(present(path), true, `${label}: ${path}`);
      assert.equal(present(s.log), false, label);
      assert.equal(serveRoots(s)[Object.keys(serveRoots(s))[0]].Handlers['/'], undefined, label);
      assert.equal(readFileSync(join(s.dir, 'pg-dbs'), 'utf8'), 'soulstream\natom\n', label);
    });
  }
});

test('inactive, failed and padded outputs are a confirmed stop; the exit code of is-active is not read', async () => {
  for (const states of [['inactive', 'inactive', 'inactive'], ['failed', 'inactive', 'failed'], ['@pad:inactive', '@pad:failed', 'inactive']]) {
    await withServer({}, async (s) => {
      const pairs = UNITS.map((unit, i) => `${unit}=${states[i]}`).join(' ');
      const result = await runUninstall(s, ['--yes'], { extra: { FAKE_IS_ACTIVE: pairs } });
      assert.equal(result.status, 0, `${pairs}\n${result.stdout}${result.stderr}`);
      assert.equal(present(s.home), false);
    });
  }
});

test('without systemctl the stop is confirmed only when none of the three unit files exist', async () => {
  const gone = createSandbox();
  try {
    installedServer(gone);
    for (const unit of UNITS) {
      execFileSync('rm', ['-f', join(gone.systemd, unit), join(gone.systemd, 'multi-user.target.wants', unit)]);
    }
    execFileSync('rm', ['-f', join(gone.bin, 'systemctl')]);
    const result = await runUninstall(gone);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(present(gone.home), false);
    assert.equal(gone.called('systemctl'), false);
  } finally { gone.cleanup(); }
  const kept = createSandbox();
  try {
    installedServer(kept);
    execFileSync('rm', ['-f', join(kept.bin, 'systemctl')]);
    const result = await runUninstall(kept);
    assert.equal(result.status, 1);
    assert.match(failedSection(result.stdout), /systemctl is not available/);
    assert.equal(present(kept.home), true);
    assert.equal(present(kept.receipt), true);
    assert.equal(kept.calls().some((line) => /^(userdel|pkill|pgrep) |DROP /.test(line)), false);
  } finally { kept.cleanup(); }
});

test('processes: pgrep exit 1 means none left, 0 leads to TERM and then KILL, anything else holds back the account', async () => {
  // Gone after TERM: no KILL.
  await withServer({}, async (s) => {
    writeState(s, 'pgrep-seq', '0\n0\n1\n');
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(s.called(`pkill -TERM -u ${FAKE_UID}`));
    assert.equal(s.called('pkill -KILL'), false);
    assert.equal(present(s.home), false);
  });
  // Survives TERM, gone after KILL.
  await withServer({}, async (s) => {
    writeState(s, 'pgrep-seq', '0\n0\n0\n0\n0\n0\n1\n');
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const calls = s.calls();
    assert.ok(indexOfCall(calls, `pkill -TERM -u ${FAKE_UID}`) < indexOfCall(calls, `pkill -KILL -u ${FAKE_UID}`));
    assert.ok(indexOfCall(calls, `pkill -KILL -u ${FAKE_UID}`) < indexOfCall(calls, 'userdel -r soulstream'));
  });
  // Survives KILL.
  await withServer({}, async (s) => {
    const result = await runUninstall(s, ['--yes'], { extra: { FAKE_PGREP_DEFAULT: '0' } });
    assert.equal(result.status, 1);
    assert.match(failedSection(result.stdout), /still running after SIGKILL/);
    assert.match(failedSection(result.stdout), /were kept because its processes were not cleared/);
    assert.equal(s.called('userdel'), false);
    for (const path of [s.home, s.receipt]) assert.equal(present(path), true, path);
    assert.equal(present(s.log), false);
  });
  // pgrep itself fails: no signal, account kept, receipt kept.
  for (const rc of ['2', '3', '127']) {
    await withServer({}, async (s) => {
      const result = await runUninstall(s, ['--yes'], { extra: { FAKE_PGREP_DEFAULT: rc } });
      assert.equal(result.status, 1, rc);
      assert.match(failedSection(result.stdout), new RegExp(`pgrep failed \\(exit ${rc}\\)`));
      assert.equal(s.called('pkill'), false);
      assert.equal(s.called('userdel'), false);
      assert.equal(present(s.home), true);
      assert.equal(present(s.receipt), true);
    });
  }
});

test('processes: a uid that is below 1000, not a plain number, or the caller\'s own is never signalled', async () => {
  for (const uid of ['0', '999', '1', 'abc', '04242', '4242424 ', String(process.geteuid())]) {
    await withServer({}, async (s) => {
      const result = await runUninstall(s, ['--yes'], { extra: { FAKE_UID: uid } });
      const label = `uid '${uid}'`;
      if (/^[1-9][0-9]{3,9}$/.test(uid) && Number(uid) !== process.geteuid()) return; // not an unsafe value here
      assert.equal(result.status, 1, label);
      assert.match(failedSection(result.stdout), /refusing to signal uid/, label);
      assert.equal(s.called('pkill'), false, label);
      assert.equal(s.called('pgrep'), false, label);
      assert.equal(s.called('userdel'), false, label);
      assert.equal(present(s.home), true, label);
    });
  }
});

test('Tailscale Serve: only the matching roots go, other paths and other proxies stay, and the result is checked', async () => {
  await withServer({}, async (s) => {
    writeState(s, 'serve.json', JSON.stringify(serveConfig({ extra443: { '/other': { Proxy: 'http://127.0.0.1:9000' } } })));
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const roots = serveRoots(s);
    assert.deepEqual(roots['node.tailnet.ts.net:443'].Handlers, { '/other': { Proxy: 'http://127.0.0.1:9000' } });
    assert.deepEqual(roots['node.tailnet.ts.net:8443'].Handlers, {});
    // The scan and the step each read the status; then the two offs; then the check.
    assert.deepEqual(nonSudo(s.calls()).filter((line) => line.startsWith('tailscale ')), [
      'tailscale serve status --json', 'tailscale serve status --json',
      'tailscale serve --https=443 --set-path=/ off', 'tailscale serve --https=8443 --set-path=/ off', 'tailscale serve status --json',
    ]);
  });
  // A root that points elsewhere, or a product proxy on the wrong port, is not ours.
  await withServer({}, async (s) => {
    const config = { Web: { 'node.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } }, 'node.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5200' } } } } };
    writeState(s, 'serve.json', JSON.stringify(config));
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(s.dir, 'serve.json'), 'utf8')), config);
    assert.equal(s.called('tailscale serve --https'), false);
  });
  // The host name is not compared, only the port and the proxy.
  await withServer({}, async (s) => {
    writeState(s, 'serve.json', JSON.stringify(serveConfig({ host: 'another-name.example.ts.net' })));
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(s.called('tailscale serve --https=443 --set-path=/ off'), true);
  });
});

test('Tailscale Serve: a status of null (nothing served) is an empty configuration, not an unreadable one', async () => {
  // Nothing installed and nothing served: no prompt, no failure.
  const empty = createSandbox();
  try {
    const result = await runBash(empty, 'source "$UNINSTALL_SH"; parse_args "$@"; run_uninstall "$UN_HOME" "$UN_RECEIPT" "$UN_SYSTEMD" "$UN_USRLOCAL" "$UN_LOG"', [], { extra: { FAKE_SERVE_STATUS_NULL: '1' } });
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, 'Nothing to uninstall.\n', '']);
    assert.ok(empty.called('tailscale serve status --json'));
  } finally { empty.cleanup(); }
  // Installed, but Serve was never configured: no off command, no Serve failure, everything else goes.
  await withServer({}, async (s) => {
    const result = await runUninstall(s, ['--yes'], { extra: { FAKE_SERVE_STATUS_NULL: '1' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /Tailscale Serve/);
    assert.equal(s.called('tailscale serve --https'), false);
    for (const path of productPaths(s)) assert.equal(present(path), false, path);
  });
});

test('Tailscale Serve: an unreadable status, a failed off command or a route still there is reported and the receipt stays', async () => {
  // Status call 1 is the scan, 2 is the step's first read, 3 is the check after the offs.
  const cases = [
    ['the step cannot read the status', { FAKE_SERVE_STATUS_FAIL_CALLS: '1 2' }, /could not read the serve status/],
    ['status is not JSON', { FAKE_SERVE_STATUS_GARBAGE: '1' }, /could not read the serve status/],
    ['off command fails', { FAKE_SERVE_OFF_FAIL: '1' }, /turning off https:443 \/ failed/],
    ['status fails after off', { FAKE_SERVE_STATUS_FAIL_CALLS: '3' }, /could not re-read the serve status/],
    ['route is still there after off', { FAKE_SERVE_OFF_NOOP: '1' }, /https:443 \/ is still present/],
  ];
  for (const [label, extra, expected] of cases) {
    await withServer({}, async (s) => {
      const result = await runUninstall(s, ['--yes'], { extra });
      assert.equal(result.status, 1, label);
      assert.match(failedSection(result.stdout), expected, label);
      assert.equal(present(s.receipt), true, label);
      // Independent steps still ran.
      assert.equal(present(s.home), false, label);
      assert.equal(present(s.log), false, label);
      assert.equal(s.called('tailscale serve reset'), false, label);
    });
  }
});

test('PostgreSQL: a role other databases depend on is kept without failing; any other error fails', async () => {
  await withServer({}, async (s) => {
    const result = await runUninstall(s, ['--yes'], { extra: { FAKE_DROP_ROLE: 'dependent' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PostgreSQL role soulstream: other databases still depend on it/);
    assert.equal(present(join(s.dir, 'pg-role')), true);
    assert.equal(present(s.receipt), false);
    assert.equal(readFileSync(join(s.dir, 'pg-dbs'), 'utf8'), '');
    // A second run does not treat the lone kept role as something to uninstall.
    const again = await runBash(s, 'source "$UNINSTALL_SH"; parse_args; run_uninstall "$UN_HOME" "$UN_RECEIPT" "$UN_SYSTEMD" "$UN_USRLOCAL" "$UN_LOG"', [], { extra: { FAKE_DROP_ROLE: 'dependent' } });
    assert.deepEqual([again.status, again.stdout], [0, 'Nothing to uninstall.\n']);
  });
  await withServer({}, async (s) => {
    const result = await runUninstall(s, ['--yes'], { extra: { FAKE_DROP_ROLE: 'other' } });
    assert.equal(result.status, 1);
    assert.match(failedSection(result.stdout), /DROP ROLE soulstream failed/);
    assert.equal(present(s.receipt), true);
  });
  await withServer({}, async (s) => {
    const result = await runUninstall(s, ['--yes'], { extra: { FAKE_DROP_DB_FAIL: '1' } });
    assert.equal(result.status, 1);
    assert.match(failedSection(result.stdout), /DROP DATABASE soulstream failed/);
    assert.match(failedSection(result.stdout), /DROP DATABASE atom failed/);
    assert.equal(s.calls().some((line) => /DROP ROLE/.test(line)), false);
    assert.equal(present(s.receipt), true);
    // The account is removed all the same: the databases are independent of it.
    assert.equal(present(s.home), false);
  });
  await withServer({}, async (s) => {
    const result = await runUninstall(s, ['--yes'], { extra: { FAKE_PSQL_DOWN: '1' } });
    assert.equal(result.status, 1);
    assert.match(failedSection(result.stdout), /could not connect as the postgres user/);
    assert.equal(s.calls().some((line) => /DROP /.test(line)), false);
    assert.equal(present(s.receipt), true);
  });
});

test('/usr/local: Node.js and the shims go only when the receipt, the version and the neighbours agree; otherwise all of it stays', async () => {
  const keptCases = [
    ['version differs from the receipt', { nodeVersion: 'v22.99.0' }, (s) => writeFileSync(s.receipt, readFileSync(s.receipt, 'utf8').replace('v22.99.0', 'v22.23.5')), /its version is v22\.99\.0 and the receipt recorded v22\.23\.5/],
    ['another global package shares lib/node_modules', {}, (s) => writeFile(join(s.usrLocal, 'lib', 'node_modules', 'pm2', 'package.json'), 'pm2'), /other global packages share lib\/node_modules: pm2/],
    ['node was there before the installer', { node: true }, (s) => writeFileSync(s.receipt, JSON.stringify({ schema: 1, node_tarball_installed: false, node_version: null, corepack_shims_created: ['pnpm', 'pnpx'], codex_npm_global_installed: true })), /was there before the installer ran/],
  ];
  for (const [label, options, tweak, expected] of keptCases) {
    await withServer(options, async (s) => {
      tweak(s);
      const result = await runUninstall(s);
      assert.equal(result.status, 0, `${label}\n${result.stdout}${result.stderr}`);
      assert.match(result.stdout, expected, label);
      for (const name of ['node', 'npm', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'corepack']) assert.equal(present(join(s.usrLocal, 'bin', name)), true, `${label}: ${name}`);
      assert.equal(present(join(s.usrLocal, 'lib', 'node_modules', 'npm', 'package.json')), true, label);
      assert.equal(present(join(s.usrLocal, 'CHANGELOG.md')), true, label);
      // The account side is independent and finished; the receipt goes with a failure-free run.
      assert.equal(present(s.home), false, label);
      assert.equal(present(s.receipt), false, label);
    });
  }
  // codex follows its own flag.
  await withServer({}, async (s) => {
    writeFileSync(s.receipt, JSON.stringify({ schema: 1, node_tarball_installed: true, node_version: 'v22.23.5', corepack_shims_created: ['pnpm'], codex_npm_global_installed: false }));
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(present(join(s.usrLocal, 'bin', 'codex')), true);
    // The codex package is a neighbour in lib/node_modules, so Node.js stays.
    assert.equal(present(join(s.usrLocal, 'bin', 'node')), true);
    assert.match(result.stdout, /other global packages share lib\/node_modules: @openai/);
  });
});

test('/usr/local: no receipt leaves everything and says how to remove it by hand', async () => {
  await withServer({ receipt: false }, async (s) => {
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /No installer receipt, so .* tools were left alone/);
    assert.match(result.stdout, /rm -f .*\/bin\/node/);
    for (const name of ['node', 'codex', 'pnpm']) assert.equal(present(join(s.usrLocal, 'bin', name)), true, name);
    assert.equal(present(s.home), false);
    assert.equal(present(s.log), false);
  });
});

test('/usr/local: a damaged receipt touches nothing there, is reported, and stays', async () => {
  const damaged = [
    ['not JSON', 'not json'],
    ['schema 2', JSON.stringify({ schema: 2, node_tarball_installed: true, node_version: 'v22.23.5', corepack_shims_created: [], codex_npm_global_installed: true })],
    ['missing field', JSON.stringify({ schema: 1, node_tarball_installed: true, node_version: 'v22.23.5' })],
    ['shim name outside the four', JSON.stringify({ schema: 1, node_tarball_installed: true, node_version: 'v22.23.5', corepack_shims_created: ['../../etc/passwd'], codex_npm_global_installed: true })],
    ['node flag without version', JSON.stringify({ schema: 1, node_tarball_installed: true, node_version: null, corepack_shims_created: [], codex_npm_global_installed: true })],
    ['empty file', ''],
  ];
  for (const [label, body] of damaged) {
    await withServer({}, async (s) => {
      writeFileSync(s.receipt, body);
      const result = await runUninstall(s);
      assert.equal(result.status, 1, label);
      assert.match(failedSection(result.stdout), /receipt .* is unreadable or invalid/, label);
      for (const name of ['node', 'codex', 'pnpm', 'npm']) assert.equal(present(join(s.usrLocal, 'bin', name)), true, `${label}: ${name}`);
      assert.equal(present(s.receipt), true, label);
      assert.equal(present(s.home), false, label);
    });
  }
  await withServer({}, async (s) => {
    execFileSync('rm', ['-f', s.receipt]);
    mkdirSync(s.receipt, { recursive: true });
    const result = await runUninstall(s);
    assert.equal(result.status, 1);
    assert.match(failedSection(result.stdout), /unreadable or invalid/);
    assert.equal(present(join(s.usrLocal, 'bin', 'node')), true);
  });
});

test('/usr/local: Node.js is removed last, a failed removal keeps it, and a rerun finishes the job', async () => {
  for (const failing of ['include/node', 'lib/node_modules/@openai/codex']) {
    await withServer({}, async (s) => {
      const result = await runUninstall(s, ['--yes'], { extra: { FAKE_RM_FAIL: failing } });
      assert.equal(result.status, 1, failing);
      assert.match(failedSection(result.stdout), /\/usr\/local|\/usr\/local|usr\/local/, failing);
      assert.equal(present(join(s.usrLocal, 'bin', 'node')), true, failing);
      assert.equal(present(s.receipt), true, failing);
      // What came before the failing step is gone.
      assert.equal(present(join(s.usrLocal, 'bin', 'pnpm')), failing === 'lib/node_modules/@openai/codex', failing);
      // Rerun after the cause is fixed: the version check still passes and the rest goes.
      const again = await runUninstall(s);
      assert.equal(again.status, 0, `${failing}\n${again.stdout}${again.stderr}`);
      for (const path of [join(s.usrLocal, 'bin', 'node'), join(s.usrLocal, 'bin', 'codex'), join(s.usrLocal, 'include', 'node'), s.receipt]) assert.equal(present(path), false, `${failing}: ${path}`);
      for (const path of neighbours(s)) assert.equal(present(path), true, path);
    });
  }
});

test('/usr/local: a link that is not the installer\'s stays and is named', async () => {
  await withServer({ codex: false }, async (s) => {
    execFileSync('rm', ['-f', join(s.usrLocal, 'bin', 'pnpm')]);
    symlinkSync('/somewhere/else/pnpm', join(s.usrLocal, 'bin', 'pnpm'));
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /pnpm: points to \/somewhere\/else\/pnpm, not the Corepack shim/);
    assert.equal(present(join(s.usrLocal, 'bin', 'pnpm')), true);
    assert.equal(present(join(s.usrLocal, 'bin', 'pnpx')), false);
    assert.equal(present(join(s.usrLocal, 'bin', 'node')), false);
  });
  // A codex link that is not npm's keeps the package too, and the leftover package keeps Node.js in place.
  await withServer({}, async (s) => {
    execFileSync('rm', ['-f', join(s.usrLocal, 'bin', 'codex')]);
    symlinkSync('/somewhere/else/codex', join(s.usrLocal, 'bin', 'codex'));
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /codex: points to \/somewhere\/else\/codex, not the installer's codex/);
    assert.equal(present(join(s.usrLocal, 'bin', 'codex')), true);
    assert.equal(present(join(s.usrLocal, 'lib', 'node_modules', '@openai', 'codex', 'package.json')), true);
    assert.equal(present(join(s.usrLocal, 'bin', 'node')), true);
  });
});

test('the account: an unexpected uid or home, a link as home, and a half install are handled by name and by safety checks', async () => {
  for (const [label, extra] of [['uid below 1000', { FAKE_GETENT_UID: '999' }], ['uid 0', { FAKE_GETENT_UID: '0' }], ['home elsewhere', { FAKE_GETENT_HOME: '/home/another' }]]) {
    await withServer({}, async (s) => {
      const result = await runUninstall(s, ['--yes'], { extra });
      assert.equal(result.status, 1, label);
      assert.match(failedSection(result.stdout), /is not what the installer creates/, label);
      assert.equal(s.called('userdel'), false, label);
      assert.equal(present(s.home), true, label);
      assert.equal(present(s.receipt), true, label);
    });
  }
  await withServer({}, async (s) => {
    const result = await runUninstall(s, ['--yes'], { extra: { FAKE_USERDEL_FAIL: '1' } });
    assert.equal(result.status, 1);
    assert.match(failedSection(result.stdout), /userdel did not remove the account/);
    assert.equal(present(s.home), true);
  });
  await withServer({}, async (s) => {
    const result = await runUninstall(s, ['--yes'], { extra: { FAKE_USERDEL_KEEP_HOME: '1' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(present(s.home), false);
  });
  // The home is a link: the link target is never followed or removed.
  await withServer({}, async (s) => {
    const elsewhere = join(s.dir, 'elsewhere');
    writeFile(join(elsewhere, 'precious.txt'), 'keep');
    execFileSync('rm', ['-rf', s.home]);
    symlinkSync(elsewhere, s.home);
    const result = await runUninstall(s);
    assert.equal(result.status, 1);
    assert.match(failedSection(result.stdout), /is a symbolic link, so it was not removed/);
    assert.equal(present(join(elsewhere, 'precious.txt')), true);
    assert.equal(s.called('userdel'), false);
    assert.equal(present(s.receipt), true);
  });
  // A home directory with no account behind it is removed by name.
  await withServer({}, async (s) => {
    execFileSync('rm', ['-f', join(s.dir, 'user')]);
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(s.called('userdel'), false);
    assert.equal(present(s.home), false);
  });
});

test('safe_rm_tree refuses relative paths, parent segments and system directories, and removes an ordinary directory', async () => {
  const sandbox = createSandbox();
  try {
    const victim = join(sandbox.dir, 'victim', 'tree');
    writeFile(join(victim, 'file'), 'x');
    const script = 'source "$UNINSTALL_SH"; safe_rm_tree "$1"; printf "%s" "$?"';
    for (const bad of ['', '/', '//', 'relative/path', '.', '..', '/home', '/home/', '/root', '/etc', '/usr', '/usr/local', '/usr/local/bin', '/var', '/var/log', '/tmp', `${victim}/../victim`, `${sandbox.dir}/./victim`]) {
      const result = await runBash(sandbox, script, [bad]);
      assert.equal(result.stdout, '1', JSON.stringify(bad));
      assert.equal(present(victim), true, JSON.stringify(bad));
    }
    const ok = await runBash(sandbox, script, [victim]);
    assert.equal(ok.stdout, '0');
    assert.equal(present(victim), false);
  } finally { sandbox.cleanup(); }
});

test('a half install is cleaned up, and the next run finds nothing and does not ask', async () => {
  const sandbox = createSandbox();
  try {
    // Only the account, its home, the install log and the units exist: no repository clones, no database, no receipt.
    writeFile(join(sandbox.home, '.bashrc'), 'x');
    writeFile(sandbox.log, 'log');
    for (const unit of UNITS) writeFile(join(sandbox.systemd, unit), '[Unit]\n');
    writeFile(join(sandbox.dir, 'user'), '');
    const first = await runUninstall(sandbox);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(present(sandbox.home), false);
    assert.equal(present(sandbox.log), false);
    // No --yes: a second run reaches the prompt only if it found something to remove, and with no terminal it would fail.
    const second = await runBash(sandbox, 'source "$UNINSTALL_SH"; parse_args "$@"; run_uninstall "$UN_HOME" "$UN_RECEIPT" "$UN_SYSTEMD" "$UN_USRLOCAL" "$UN_LOG"', []);
    assert.deepEqual([second.status, second.stdout, second.stderr], [0, 'Nothing to uninstall.\n', '']);
  } finally { sandbox.cleanup(); }
});

test('a run on a server with nothing installed changes nothing and calls no mutating command', async () => {
  const sandbox = createSandbox();
  try {
    const result = await runUninstall(sandbox, []);
    assert.deepEqual([result.status, result.stdout], [0, 'Nothing to uninstall.\n']);
    assert.equal(sandbox.calls().some((line) => /^(systemctl|pkill|crontab|userdel)|DROP |--set-path/.test(line)), false);
  } finally { sandbox.cleanup(); }
});

test('a query that fails is not read as an empty server: the run goes on and reports it', async () => {
  const sandbox = createSandbox();
  try {
    writeState(sandbox, 'pg-dbs', '');
    const result = await runUninstall(sandbox, ['--yes'], { extra: { FAKE_PSQL_DOWN: '1' } });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Nothing to uninstall/);
    assert.match(failedSection(result.stdout), /could not connect as the postgres user/);
  } finally { sandbox.cleanup(); }
});

test('without a terminal and without --yes nothing is removed; with --yes it finishes, and no secret is printed', async () => {
  await withServer({}, async (s) => {
    const refused = await runBash(s, 'source "$UNINSTALL_SH"; parse_args "$@"; run_uninstall "$UN_HOME" "$UN_RECEIPT" "$UN_SYSTEMD" "$UN_USRLOCAL" "$UN_LOG"', []);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /No interactive terminal available\. Re-run with --yes to confirm permanent removal\./);
    for (const path of productPaths(s)) assert.equal(present(path), true, path);
    assert.equal(s.calls().some((line) => /^(systemctl|pkill|crontab|userdel)|DROP |--set-path/.test(line)), false);
    assert.equal(`${refused.stdout}${refused.stderr}`.includes(SECRET), false);
    const done = await runUninstall(s, ['--yes']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal(`${done.stdout}${done.stderr}`.includes(SECRET), false);
    assert.match(done.stdout, /WARNING: This permanently deletes/);
    assert.equal(present(s.home), false);
  });
});

// The prompt tests need script(1) from util-linux. Without it they fail; they are never skipped.
test('script(1) is available for the terminal prompt tests', () => {
  assert.ok(scriptPath(), 'script (util-linux) was not found on PATH; the terminal prompt tests need it');
});

test('on a terminal, y, yes and " YES " confirm', async () => {
  for (const answer of ['y\n', 'yes\n', ' YES \n', 'Y\r\n']) {
    await withServer({}, async (s) => {
      const result = await ptyUninstall(s, [], answer);
      assert.equal(result.prompted, true, JSON.stringify(answer));
      assert.match(result.stdout, /Type yes \(or y\) to permanently remove these items \[y\/N\]: /);
      assert.equal(result.status, 0, `${JSON.stringify(answer)}\n${result.stdout}${result.stderr}`);
      assert.equal(present(s.home), false, JSON.stringify(answer));
      assert.equal(present(s.receipt), false, JSON.stringify(answer));
    });
  }
});

test('on a terminal, an empty line, n, no, anything else and end of input remove nothing', async () => {
  for (const answer of ['\n', 'n\n', 'no\n', 'yes please\n', 'ye\n', '']) {
    await withServer({}, async (s) => {
      const result = await ptyUninstall(s, [], answer);
      assert.equal(result.prompted, true, JSON.stringify(answer));
      assert.equal(result.status, 1, `${JSON.stringify(answer)}\n${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /Aborted\. Nothing was removed\./, JSON.stringify(answer));
      for (const path of productPaths(s)) assert.equal(present(path), true, `${JSON.stringify(answer)}: ${path}`);
      assert.equal(s.calls().some((line) => /^(systemctl|pkill|crontab|userdel)|DROP |--set-path/.test(line)), false, JSON.stringify(answer));
    });
  }
});

test('on a terminal, --yes does not ask', async () => {
  await withServer({}, async (s) => {
    const result = await ptyUninstall(s, ['--yes'], 'n\n');
    assert.equal(result.prompted, false);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(present(s.home), false);
  });
});

// The shared /usr/local directories, in the order uninstall.sh walks them (. is /usr/local itself).
const SHARED_DIRS = ['.', 'bin', 'lib', 'include', 'share', 'share/man', 'share/man/man1', 'share/doc', 'lib/node_modules'];
const sharedDir = (s, rel) => (rel === '.' ? s.usrLocal : join(s.usrLocal, rel));
const chownCalls = (s) => s.calls().filter((line) => line.startsWith('chown '));
const OWNED_BY_SOULSTREAM = 'soulstream:soulstream';

test('/usr/local owners: a shared directory that is not root:root is reset, only that one, not recursively, and the Removed list says so', async () => {
  await withServer({}, async (s) => {
    const wrong = [s.usrLocal, join(s.usrLocal, 'bin'), join(s.usrLocal, 'share', 'man', 'man1')];
    for (const path of wrong) setOwner(s, path, OWNED_BY_SOULSTREAM);
    // Someone else's files inside those directories are not ours to change, whoever owns them.
    const neighbourFiles = [join(s.usrLocal, 'bin', 'other-tool'), join(s.usrLocal, 'lib', 'python3')];
    for (const path of neighbourFiles) setOwner(s, path, OWNED_BY_SOULSTREAM);
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(chownCalls(s), wrong.map((path) => `chown -h root:root -- ${path}`));
    assert.ok(result.stdout.includes(`  - Non-root ownership reset to root:root on: ${wrong.join(', ')}\n`), result.stdout);
    assert.deepEqual(ownerTable(s), Object.fromEntries(neighbourFiles.map((path) => [path, OWNED_BY_SOULSTREAM])));
    // The step runs after the services are confirmed stopped and before the account goes.
    const calls = s.calls();
    assert.ok(indexOfCall(calls, 'systemctl is-active soulstream-atom.service') < indexOfCall(calls, 'chown '));
    assert.ok(indexOfCall(calls, 'chown ') < indexOfCall(calls, 'userdel -r soulstream'));
  });
});

test('/usr/local owners: every shared directory in the list is checked, and each wrong one gets its own chown', async () => {
  await withServer({}, async (s) => {
    for (const rel of SHARED_DIRS) mkdirSync(sharedDir(s, rel), { recursive: true });
    for (const rel of SHARED_DIRS) setOwner(s, sharedDir(s, rel), 'root:nogroup');
    // A node that stays (version differs) keeps lib/node_modules in place.
    writeFile(join(s.usrLocal, 'lib', 'node_modules', 'pm2', 'package.json'), 'pm2');
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(chownCalls(s), SHARED_DIRS.map((rel) => `chown -h root:root -- ${sharedDir(s, rel)}`));
    assert.deepEqual(ownerTable(s), {});
  });
});

test('/usr/local owners: directories that already have the expected owner are not touched and nothing is said about them', async () => {
  await withServer({}, async (s) => {
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(chownCalls(s), []);
    assert.doesNotMatch(result.stdout, /ownership/i);
  });
  // The group alone being wrong is enough, and the expected pair root:staff is not a difference without the marker file.
  await withServer({}, async (s) => {
    setOwner(s, join(s.usrLocal, 'lib'), 'root:staff');
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(chownCalls(s), [`chown -h root:root -- ${join(s.usrLocal, 'lib')}`]);
  });
});

test('/usr/local owners: with the base-files marker file the expected owner is root:staff', async () => {
  await withServer({}, async (s) => {
    writeFile(s.staffMarker, '');
    setOwner(s, join(s.usrLocal, 'lib'), 'root:staff');
    setOwner(s, join(s.usrLocal, 'include'), OWNED_BY_SOULSTREAM);
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // bin and the others are root:root here, which differs from root:staff; lib already is root:staff.
    const expected = SHARED_DIRS.filter((rel) => rel !== 'lib' && existsSync(sharedDir(s, rel)));
    assert.ok(chownCalls(s).every((line) => line.startsWith('chown -h root:staff -- ')), chownCalls(s).join('\n'));
    assert.equal(chownCalls(s).some((line) => line.endsWith(` -- ${join(s.usrLocal, 'lib')}`)), false);
    assert.equal(chownCalls(s).length, expected.length);
    assert.match(result.stdout, /Non-root ownership reset to root:staff on: /);
  });
});

test('/usr/local owners: a failed chown is reported under Failed, the run exits 1 and the receipt stays', async () => {
  await withServer({}, async (s) => {
    setOwner(s, join(s.usrLocal, 'bin'), OWNED_BY_SOULSTREAM);
    setOwner(s, join(s.usrLocal, 'lib'), OWNED_BY_SOULSTREAM);
    const result = await runUninstall(s, ['--yes'], { extra: { FAKE_CHOWN_FAIL: `${join(s.usrLocal, 'bin')}` } });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(failedSection(result.stdout), /could not change the owner of .*\/usr\/local\/bin to root:root/);
    // The directory that could be fixed was, and says so.
    assert.ok(result.stdout.includes(`Non-root ownership reset to root:root on: ${join(s.usrLocal, 'lib')}\n`), result.stdout);
    assert.equal(present(s.receipt), true);
    assert.deepEqual(ownerTable(s), { [join(s.usrLocal, 'bin')]: OWNED_BY_SOULSTREAM });
  });
});

test('/usr/local owners: a missing or damaged receipt does not stop the reset', async () => {
  await withServer({ receipt: false }, async (s) => {
    setOwner(s, join(s.usrLocal, 'share'), OWNED_BY_SOULSTREAM);
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(chownCalls(s), [`chown -h root:root -- ${join(s.usrLocal, 'share')}`]);
    assert.match(result.stdout, /Non-root ownership reset to root:root on: /);
  });
  await withServer({}, async (s) => {
    writeFileSync(s.receipt, 'not json');
    setOwner(s, join(s.usrLocal, 'share'), OWNED_BY_SOULSTREAM);
    const result = await runUninstall(s);
    assert.equal(result.status, 1);
    assert.deepEqual(chownCalls(s), [`chown -h root:root -- ${join(s.usrLocal, 'share')}`]);
    assert.match(failedSection(result.stdout), /receipt .* is unreadable or invalid/);
  });
});

test('/usr/local owners: nothing is changed while the services are not confirmed stopped', async () => {
  await withServer({}, async (s) => {
    setOwner(s, join(s.usrLocal, 'bin'), OWNED_BY_SOULSTREAM);
    const result = await runUninstall(s, ['--yes'], { extra: { FAKE_IS_ACTIVE: 'soulstream-orch.service=active' } });
    assert.equal(result.status, 1);
    assert.deepEqual(chownCalls(s), []);
    assert.deepEqual(ownerTable(s), { [join(s.usrLocal, 'bin')]: OWNED_BY_SOULSTREAM });
    assert.doesNotMatch(result.stdout, /Non-root ownership/);
  });
});

test('/usr/local owners: a Node.js that is kept keeps its own files\' owners, and a link as a directory is not followed', async () => {
  await withServer({ nodeVersion: 'v22.99.0' }, async (s) => {
    writeFileSync(s.receipt, readFileSync(s.receipt, 'utf8').replace('v22.99.0', 'v22.23.5'));
    const bundle = [join(s.usrLocal, 'bin', 'node'), join(s.usrLocal, 'lib', 'node_modules', 'npm'), join(s.usrLocal, 'include', 'node')];
    for (const path of bundle) setOwner(s, path, OWNED_BY_SOULSTREAM);
    setOwner(s, join(s.usrLocal, 'include'), OWNED_BY_SOULSTREAM);
    // share/doc is a link to a directory somewhere else: left alone whoever owns the target.
    rmSync(join(s.usrLocal, 'share', 'doc'), { recursive: true });
    mkdirSync(join(s.dir, 'elsewhere'));
    symlinkSync(join(s.dir, 'elsewhere'), join(s.usrLocal, 'share', 'doc'));
    setOwner(s, join(s.usrLocal, 'share', 'doc'), OWNED_BY_SOULSTREAM);
    const result = await runUninstall(s);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Node\.js and Corepack shims in .*: its version is v22\.99\.0/);
    assert.deepEqual(chownCalls(s), [`chown -h root:root -- ${join(s.usrLocal, 'include')}`]);
    assert.deepEqual(ownerTable(s), { ...Object.fromEntries(bundle.map((path) => [path, OWNED_BY_SOULSTREAM])), [join(s.usrLocal, 'share', 'doc')]: OWNED_BY_SOULSTREAM });
  });
});

test('install.sh sources quietly and names the receipt and /usr/local locations as plain constants', async () => {
  const sandbox = createSandbox();
  try {
    const result = await runBash(sandbox, 'source "$INSTALL_SH"; printf "%s %s\\n" "$RECEIPT_FILE" "$USR_LOCAL"');
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, '/etc/soulstream/install-receipt.json /usr/local\n', '']);
    assert.equal(resolve(installScript).endsWith('install/install.sh'), true);
    assert.deepEqual(sandbox.calls(), []);
  } finally { sandbox.cleanup(); }
});

test('the temporary servers hold no leftover of the real host: the fake PATH hides the real system commands', async () => {
  const sandbox = createSandbox();
  try {
    const result = await runBash(sandbox, 'for name in systemctl psql sudo userdel pkill pgrep crontab tailscale chown find npm corepack; do printf "%s=%s\\n" "$name" "$(type -P "$name")"; done');
    assert.equal(result.status, 0);
    const found = Object.fromEntries(result.stdout.trim().split('\n').map((line) => line.split('=')));
    for (const name of ['systemctl', 'psql', 'sudo', 'userdel', 'pkill', 'pgrep', 'crontab', 'tailscale', 'chown', 'find']) assert.equal(found[name], join(sandbox.bin, name), name);
    for (const name of ['npm', 'corepack']) assert.equal(found[name], '', name);
    assert.deepEqual(listTree(sandbox.dir).filter((path) => !/^(fake-bin|tools)/.test(path)), []);
  } finally { sandbox.cleanup(); }
});

test('no test created /etc/soulstream or the install log on this host', () => {
  assertHostUntouched(hostBefore);
});
