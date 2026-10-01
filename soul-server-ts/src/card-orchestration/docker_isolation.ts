import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { open } from 'node:fs/promises';

export interface IsolatedProcessResult { exitCode: number; stdout: string; stderr: string }
export interface IsolationRun {
  stageDir: string;
  entrypoint: string;
  args: readonly string[];
  signal: AbortSignal;
  /** Trusted native binary, never a profile workspace or a credential directory. */
  codexBinary?: string;
}

/** The only host reads granted to Codex are this run's input and the native executable. */
export class DockerDecisionIsolation {
  constructor(private readonly options: { image: string; timeoutMs: number; dockerPath?: string }) {
    if (!/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(options.image)) {
      throw new Error('Decision image must have an immutable digest');
    }
  }

  async prepare(codexBinary: string): Promise<void> {
    try { await assertNativeCodex(codexBinary); } catch { throw new Error('codex_native_binary_unavailable'); }
    await new Promise<void>((resolve, reject) => execFile(this.options.dockerPath ?? '/usr/bin/docker',
      ['image', 'inspect', this.options.image, '--format', '{{.Id}}'],
      { env: { PATH: '/usr/bin:/bin' }, timeout: 10000 }, (error, stdout) => {
        if (error || !stdout.trim()) reject(new Error('docker_image_or_daemon_unavailable')); else resolve();
      }));
  }

  async run(run: IsolationRun): Promise<IsolatedProcessResult> {
    if (run.signal.aborted) return { exitCode: -1, stdout: '', stderr: 'decision_aborted' };
    for (const path of [run.stageDir, run.codexBinary].filter((value): value is string => value !== undefined)) {
      if (!isAbsolute(path) || /[,\n\r]/.test(path)) throw new Error('Invalid trusted isolation path');
    }
    if (run.codexBinary) await assertNativeCodex(run.codexBinary);
    const name = `soul-decision-${randomUUID()}`;
    const docker = this.options.dockerPath ?? '/usr/bin/docker';
    const env = { PATH: '/usr/bin:/bin' };
    const args = [
      'run', '--rm', '--pull=never', '--name', name, '--network=none', '--ipc=none',
      '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=64', '--memory=512m', '--cpus=1',
      '--user', `${process.getuid?.() ?? 65534}:${process.getgid?.() ?? 65534}`,
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
      '--tmpfs', '/home/decision:rw,noexec,nosuid,size=64m,mode=1777',
      '--env', 'HOME=/home/decision', '--env', 'CODEX_HOME=/home/decision/.codex',
      '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
      '--mount', `type=bind,src=${run.stageDir},dst=/input,readonly`,
      ...(run.codexBinary ? ['--mount', `type=bind,src=${run.codexBinary},dst=/runtime/codex,readonly`] : []),
      '--workdir', '/home/decision', '--entrypoint', run.entrypoint,
      this.options.image, ...run.args,
    ];
    try {
      return await new Promise<IsolatedProcessResult>((resolve) => {
        let stdout = ''; let stderr = ''; let settled = false;
        const child = spawn(docker, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        const finish = (exitCode: number, reason?: string) => {
          if (settled) return;
          settled = true; clearTimeout(timer); run.signal.removeEventListener('abort', abort);
          resolve({ exitCode, stdout, stderr: reason ?? stderr });
        };
        const abort = () => { child.kill('SIGKILL'); finish(-1, 'decision_aborted'); };
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish(-1, 'isolation_timeout'); }, this.options.timeoutMs);
        run.signal.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString('utf8');
          if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) { child.kill('SIGKILL'); finish(-1, 'output_limit'); }
        });
        child.stderr.on('data', (data: Buffer) => { if (stderr.length < 8192) stderr += data.toString('utf8'); });
        child.on('error', () => finish(-1, 'isolation_unavailable'));
        child.on('close', (code) => finish(code ?? -1));
      });
    } finally {
      // Killing the Docker client alone does not kill its container. Remove only this run's random name.
      await new Promise<void>((resolve) => execFile(docker, ['rm', '-f', name], { env, timeout: 10000 }, () => resolve()));
    }
  }
}

async function assertNativeCodex(path: string): Promise<void> {
  if (!isAbsolute(path) || /[,\n\r]/.test(path)) throw new Error('Invalid trusted isolation path');
  const executable = await open(path, 'r');
  try {
    const header = Buffer.alloc(4);
    await executable.read(header, 0, 4, 0);
    const stat = await executable.stat();
    if (!stat.isFile() || !(stat.mode & 0o111) || !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error('Decision Codex path must be a native ELF executable');
    }
  } finally { await executable.close(); }
}
