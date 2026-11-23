// Starts a throwaway atom API server for the seed loader integration tests.
//
// Requires ATOM_TEST_DIR: a built atom checkout (main b88c7a5b in the unit's
// verify step). A missing checkout, a missing build or a .env in the checkout
// fails the test instead of skipping it — atom loads <checkout>/.env with
// override:true (src/api/index.ts), which would silently replace the test env.
//
// The server gets only the environment it needs. OAuth variables are left out
// on purpose: their presence would switch atom to OAuth mode. Each call gets a
// fresh temp directory, SQLite database and port, and stop() removes them.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function startAtom() {
  const atomDir = process.env.ATOM_TEST_DIR;
  if (!atomDir) throw new Error('ATOM_TEST_DIR is required (a built atom checkout)');
  const entry = path.join(atomDir, 'dist/api/index.js');
  if (!fs.existsSync(entry)) throw new Error(`atom build is missing: ${entry}`);
  if (fs.existsSync(path.join(atomDir, '.env'))) {
    throw new Error(`${path.join(atomDir, '.env')} must not exist; atom reads it with override:true`);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atom-test-'));
  const home = path.join(temp, 'home');
  fs.mkdirSync(home);
  const password = randomBytes(18).toString('base64url');
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    cwd: temp,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      NODE_ENV: 'production',
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      SQLITE_PATH: path.join(temp, 'atom.db'),
      DASHBOARD_ADMIN_PASSWORD: password,
      JWT_SECRET: randomBytes(32).toString('base64url'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-20000);
  });
  child.stdout.resume();

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  try {
    for (;;) {
      if (child.exitCode !== null) throw new Error(`atom exited before the health check (code ${child.exitCode}): ${stderr}`);
      try {
        const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (response.status === 200) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new Error(`atom health check timed out: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } catch (error) {
    child.kill('SIGKILL');
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }

  return {
    url,
    password,
    temp,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      fs.rmSync(temp, { recursive: true, force: true });
    },
  };
}
