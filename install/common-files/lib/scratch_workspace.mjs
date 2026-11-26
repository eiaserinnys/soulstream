import path from 'node:path';

export function scratchWorkspaceRoot(env = process.env, cwd = process.cwd()) {
  const configured = env.SCRATCH_WORKSPACE_DIR;
  return path.resolve(configured && configured.trim() !== '' ? configured : cwd);
}

export function scratchPaths(env = process.env, cwd = process.cwd()) {
  const root = scratchWorkspaceRoot(env, cwd);
  return {
    root,
    tmp: path.join(root, '.local', 'tmp'),
    artifacts: path.join(root, '.local', 'artifacts'),
  };
}

export function scratchSubpath(kind, name, env = process.env, cwd = process.cwd()) {
  const paths = scratchPaths(env, cwd);
  if (kind !== 'tmp' && kind !== 'artifacts') throw new Error(`kind must be "tmp" or "artifacts": ${kind}`);
  const base = paths[kind];
  const target = path.resolve(base, name);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`path escapes .local/${kind}: ${name}`);
  return target;
}
