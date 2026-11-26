// Small helpers shared by the Windows installer steps. Built-in modules only: these run before any dependency is installed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export const isWindows = process.platform === 'win32';

export const log = (message) => process.stdout.write(`${message}\n`);

export function fail(message) {
  const error = new Error(message);
  error.installerMessage = true;
  return error;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    if (!name?.startsWith('--') || rest[i + 1] === undefined) throw fail(`Unexpected argument: ${name}`);
    options[name.slice(2)] = rest[i + 1];
  }
  return { command, options };
}

// Value of key in an env file; a missing file or key is ''. Same reading as install.sh read_env_value.
export function readEnvValue(file, key) {
  if (!existsSync(file)) return '';
  let value = '';
  for (const line of readFileSync(file, 'utf8').split('\n')) if (line.startsWith(`${key}=`)) value = line.slice(key.length + 1);
  return value.replace(/\r$/, '').replace(/^"/, '').replace(/"$/, '');
}

// Every key of an env file as the services read it: dotenv rules for quotes, no escape processing.
export function parseEnvFile(file) {
  const values = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    let value = line.slice(at + 1).trim();
    if (/^(['"]).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    values[line.slice(0, at).trim()] = value;
  }
  return values;
}

// cmd.exe quoting for the command and arguments of .cmd shims (npm, pnpm, corepack).
function cmdQuote(token) {
  return token === '' || /[\s&|<>^%()!,;=]/.test(token) ? `"${token}"` : token;
}

function spawnTarget(command, args) {
  if (isWindows && /^(npm|npx|pnpm|corepack|codex|claude)$/i.test(command)) {
    return { command: [command, ...args].map(cmdQuote).join(' '), args: [], shell: true };
  }
  return { command, args, shell: false };
}

// Runs a command with output appended to the log stream; throws on a nonzero exit.
export function run(command, args, { cwd, env, input, capture = false, label } = {}) {
  const target = spawnTarget(command, args);
  const result = spawnSync(target.command, target.args, {
    cwd,
    env: { ...process.env, ...env },
    input,
    shell: target.shell,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'inherit', 'inherit'],
  });
  if (result.error) throw fail(`${label ?? command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = capture ? `\n${(result.stderr || result.stdout || '').trim()}` : '';
    throw fail(`${label ?? `${command} ${args.join(' ')}`} failed with exit code ${result.status}.${detail}`);
  }
  return capture ? result.stdout : '';
}

// Stops a process this installer started, with its children. Only a PID is ever used to pick the target.
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

export function startDetached(command, args, { cwd, env, outFile }) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', outFile, outFile], windowsHide: true });
  return child;
}

export async function httpRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  return { status: response.status, json, text, cookie };
}

// Polls fn until it returns a truthy value or the deadline passes; a thrown error counts as not ready.
export async function waitFor(description, fn, { timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { /* not ready */ }
    if (Date.now() >= deadline) throw fail(`Timed out waiting for ${description}.`);
    await sleep(intervalMs);
  }
}
