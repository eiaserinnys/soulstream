// Finds the coding agent CLIs in the places the worker searches on Windows, so a missing CLI stops the install with a
// clear message instead of a worker that never starts.
import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import { fail } from './lib.mjs';

const EXTRA_DIRECTORIES = {
  claude: (env) => [env.USERPROFILE && win32.join(env.USERPROFILE, '.local', 'bin')],
  codex: (env) => [env.APPDATA && win32.join(env.APPDATA, 'npm')],
};

const INSTALL_HINTS = {
  claude: 'irm https://claude.ai/install.ps1 | iex',
  codex: 'npm install -g @openai/codex',
};

const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

export function findCli(name, env = process.env) {
  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const directories = [...(env.PATH ?? env.Path ?? '').split(';'), ...EXTRA_DIRECTORIES[name](env)]
    .map((dir) => dir?.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  for (const dir of directories) {
    for (const ext of extensions) {
      const candidate = win32.join(dir, `${name}${ext.toLowerCase()}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function requireClis(backends, env = process.env) {
  return Object.fromEntries(backends.map((name) => {
    const path = findCli(name, env);
    if (!path) {
      throw fail(`The ${name} CLI was not found on PATH or in its default install folder. Install it with \`${INSTALL_HINTS[name]}\`, or leave it out with -Backends, then run this script again.`);
    }
    return [name, path];
  }));
}
