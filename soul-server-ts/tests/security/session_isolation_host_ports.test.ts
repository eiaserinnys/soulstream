import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionIsolationUnavailableError } from "../../src/runner/session_filesystem_errors.js";
import { createIsolationHostPorts } from "../../src/runner/session_isolation_host_ports.js";
import { makeTempDir } from "../helpers/temp_dir.js";
import { touch } from "../helpers/session_isolation_host_fakes.js";

import {
  createDeps,
  createRecordingRunCommand,
} from "./session_isolation_host_ports_fixtures.js";

/** 이 파일의 포트는 외부 명령을 부르지 않는다. runCommand는 항상 가짜다. */
async function createPorts(root: string) {
  const recording = createRecordingRunCommand();
  const deps = createDeps(root, { runCommand: recording.runCommand });
  return { ports: createIsolationHostPorts(deps), deps, calls: recording.calls };
}

describe("session isolation host ports — filesystem", () => {
  it("ensureDirectory는 없으면 만들고 기존 디렉터리의 mode를 맞춘다", async () => {
    const root = await makeTempDir("host-ports-dir-");
    const { ports } = await createPorts(root);
    const target = join(root, "a", "b");

    await ports.ensureDirectory(target, 0o700);
    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(lstatSync(target).mode & 0o777).toBe(0o700);

    chmodSync(target, 0o755);
    await ports.ensureDirectory(target, 0o700);
    expect(lstatSync(target).mode & 0o777).toBe(0o700);
  });

  it("ensureDirectory는 symlink를 거절한다", async () => {
    const root = await makeTempDir("host-ports-dir-symlink-");
    const { ports } = await createPorts(root);
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(root, "link");
    symlinkSync(real, link);

    await expect(ports.ensureDirectory(link, 0o700)).rejects.toBeInstanceOf(
      SessionIsolationUnavailableError,
    );
  });

  it("writeFile은 mode를 맞춰 쓰고 symlink 대상을 거절한다", async () => {
    const root = await makeTempDir("host-ports-write-");
    const { ports } = await createPorts(root);
    // 상위 디렉터리 준비는 B2(ensureDirectory)의 몫이다.
    const sandboxDirectory = join(root, "sandbox");
    mkdirSync(sandboxDirectory, { recursive: true, mode: 0o700 });
    const target = join(sandboxDirectory, "resolv.conf");

    await ports.writeFile(target, "nameserver 192.0.2.53\n", 0o644);
    expect(readFileSync(target, "utf8")).toBe("nameserver 192.0.2.53\n");
    expect(lstatSync(target).mode & 0o777).toBe(0o644);

    const victim = touch(root, "sandbox/victim.txt", "original", 0o600);
    const link = join(root, "sandbox", "link.txt");
    symlinkSync(victim, link);
    await expect(ports.writeFile(link, "replaced", 0o600)).rejects.toBeInstanceOf(
      SessionIsolationUnavailableError,
    );
    expect(readFileSync(victim, "utf8")).toBe("original");
  });

  it("copyFile은 mode를 맞춰 복사하고 symlink 대상을 거절한다", async () => {
    const root = await makeTempDir("host-ports-copy-");
    const { ports } = await createPorts(root);
    const source = touch(root, "git/config", "[core]\n", 0o600);
    // 상위 디렉터리 준비는 B2(ensureDirectory)의 몫이다.
    const view = join(root, "view");
    mkdirSync(view, { recursive: true, mode: 0o700 });
    const destination = join(view, "config");

    await ports.copyFile(source, destination, 0o600);
    expect(readFileSync(destination, "utf8")).toBe("[core]\n");
    expect(lstatSync(destination).mode & 0o777).toBe(0o600);

    const victim = touch(root, "view/victim", "original", 0o600);
    const link = join(root, "view", "link");
    symlinkSync(victim, link);
    await expect(ports.copyFile(source, link, 0o600)).rejects.toBeInstanceOf(
      SessionIsolationUnavailableError,
    );
    expect(readFileSync(victim, "utf8")).toBe("original");
  });

  it("resolveRealPath는 정규 경로를 돌려주고 없는 경로의 오류를 그대로 던진다", async () => {
    const root = await makeTempDir("host-ports-realpath-");
    const { ports } = await createPorts(root);
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(root, "link");
    symlinkSync(real, link);

    await expect(ports.resolveRealPath(link)).resolves.toBe(realpathSync(real));
    await expect(ports.resolveRealPath(join(root, "missing"))).rejects.toThrow(/ENOENT/);
  });

  it("lstatPath는 종류와 inode 사실만 돌려주고 없는 경로는 null이다", async () => {
    const root = await makeTempDir("host-ports-lstat-");
    const { ports } = await createPorts(root);
    const file = touch(root, "facts/file.txt", "x", 0o600);
    const directory = join(root, "facts", "dir");
    mkdirSync(directory, { mode: 0o700 });
    const link = join(root, "facts", "link");
    symlinkSync(file, link);

    await expect(ports.lstatPath(file)).resolves.toMatchObject({ kind: "file", nlink: 1 });
    await expect(ports.lstatPath(directory)).resolves.toMatchObject({ kind: "directory" });
    await expect(ports.lstatPath(link)).resolves.toMatchObject({ kind: "symlink" });
    await expect(ports.lstatPath(join(root, "facts", "missing"))).resolves.toBeNull();

    const fact = await ports.lstatPath(file);
    expect(typeof fact?.dev).toBe("number");
    expect(typeof fact?.ino).toBe("number");
  });

  it("listDirectory는 이름과 종류만 돌려준다", async () => {
    const root = await makeTempDir("host-ports-listdir-");
    const { ports } = await createPorts(root);
    touch(root, "listing/file.txt", "content", 0o600);
    mkdirSync(join(root, "listing", "subdir"), { mode: 0o700 });
    symlinkSync(join(root, "listing", "file.txt"), join(root, "listing", "link"));

    const entries = (await ports.listDirectory(join(root, "listing")))
      .sort((left, right) => left.name.localeCompare(right.name));

    expect(entries).toEqual([
      { name: "file.txt", kind: "file" },
      { name: "link", kind: "symlink" },
      { name: "subdir", kind: "directory" },
    ]);
  });

  it("readSymlink는 대상 경로만 읽고 일반 파일과 없는 경로는 null이다", async () => {
    const root = await makeTempDir("host-ports-readlink-");
    const { ports } = await createPorts(root);
    const target = touch(root, "links/target", "", 0o600);
    const link = join(root, "links", "entry");
    symlinkSync(target, link);

    await expect(ports.readSymlink(link)).resolves.toBe(target);
    await expect(ports.readSymlink(target)).resolves.toBeNull();
    await expect(ports.readSymlink(join(root, "links", "missing"))).resolves.toBeNull();
  });

  it("detectWsl은 커널 표식만 보고 읽기 실패는 false다", async () => {
    const root = await makeTempDir("host-ports-wsl-");
    const osrelease = touch(
      root,
      "proc-sys-kernel-osrelease",
      "5.15.153.1-microsoft-standard-WSL2\n",
      0o644,
    );
    const { ports } = await createPorts(root);
    await expect(ports.detectWsl()).resolves.toBe(true);

    const missingRoot = await makeTempDir("host-ports-wsl-missing-");
    const missing = createIsolationHostPorts(createDeps(missingRoot));
    await expect(missing.detectWsl()).resolves.toBe(false);
    expect(osrelease.endsWith("proc-sys-kernel-osrelease")).toBe(true);
  });

  it("ensureLockFile은 기존 내용과 mode를 유지하고 symlink를 거절한다", async () => {
    const root = await makeTempDir("host-ports-lock-");
    const { ports } = await createPorts(root);
    const lock = join(root, "locks", "gate.lock");
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    writeFileSync(lock, "keep-me\n", { mode: 0o644 });
    chmodSync(lock, 0o644);

    await ports.ensureLockFile(lock, 0o600);
    expect(readFileSync(lock, "utf8")).toBe("keep-me\n");
    expect(lstatSync(lock).mode & 0o777).toBe(0o644);

    const fresh = join(root, "locks", "fresh.lock");
    await ports.ensureLockFile(fresh, 0o600);
    expect(lstatSync(fresh).isFile()).toBe(true);

    const victim = join(root, "locks", "victim");
    writeFileSync(victim, "", { mode: 0o600 });
    const link = join(root, "locks", "link.lock");
    symlinkSync(victim, link);
    await expect(ports.ensureLockFile(link, 0o600)).rejects.toBeInstanceOf(
      SessionIsolationUnavailableError,
    );
  });

  it("ensureSymlink는 같은 대상이면 그대로 두고 충돌을 거절한다", async () => {
    const root = await makeTempDir("host-ports-symlink-");
    const { ports } = await createPorts(root);
    const target = touch(root, "codex/auth.json", "{}", 0o600);
    const other = touch(root, "codex/other.json", "{}", 0o600);
    const link = join(root, "codex-home", "auth.json");
    mkdirSync(dirname(link), { recursive: true, mode: 0o700 });

    await ports.ensureSymlink(target, link);
    expect(readlinkSync(link)).toBe(target);
    await ports.ensureSymlink(target, link);
    expect(readlinkSync(link)).toBe(target);

    await expect(ports.ensureSymlink(other, link)).rejects.toBeInstanceOf(
      SessionIsolationUnavailableError,
    );

    const occupied = touch(root, "codex-home/occupied", "", 0o600);
    await expect(ports.ensureSymlink(target, occupied)).rejects.toBeInstanceOf(
      SessionIsolationUnavailableError,
    );
  });

  it("hashFileSha512는 내용의 sha512 hex를 돌려준다", async () => {
    const root = await makeTempDir("host-ports-hash-");
    const { ports } = await createPorts(root);
    const file = touch(root, "hash/blob.bin", "hello", 0o600);

    await expect(ports.hashFileSha512(file)).resolves.toBe(
      createHash("sha512").update("hello").digest("hex"),
    );
  });
});
