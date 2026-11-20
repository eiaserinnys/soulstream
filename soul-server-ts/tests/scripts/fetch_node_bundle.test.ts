import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

const packageRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const scriptPath = join(packageRoot, "scripts", "fetch_node_bundle.mjs");

const temporaryRoots: string[] = [];
const servers: ReleaseServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("fetch_node_bundle", () => {
  it("installs the bundle, binds it, and swaps the existing dist", async () => {
    const world = await makeWorld();
    temporaryRoots.push(world.root);
    await mkdir(world.installDir, { recursive: true });
    await writeFile(join(world.installDir, "stale.txt"), "old\n");

    const server = await startReleaseServer();
    const tarball = makeBundle(world.sha);
    publish(server, world.sha, tarball);

    const result = await runFetch(world, { baseUrl: server.url });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`fetch-node-bundle: commit ${world.sha}`);
    expect(result.stdout).toContain("fetch-node-bundle: source download");
    expect(result.stdout).toMatch(/fetch-node-bundle: step bind \d+\.\d+s/);

    expect((await readdir(world.installDir)).sort()).toEqual([
      "bind-release.mjs",
      "main.js",
      "portable-release.json",
      "release-manifest.json",
    ]);
    await expect(stat(join(world.installDir, "stale.txt"))).rejects.toThrow();
    await expect(stat(`${world.installDir}.next`)).rejects.toThrow();
    await expect(stat(`${world.installDir}.old`)).rejects.toThrow();
    expect((await readdir(world.cacheDir)).sort()).toEqual([
      `node-${world.sha}.tar.gz`,
      `node-${world.sha}.tar.gz.sha256`,
    ]);
    expect(await readFile(join(world.cacheDir, `node-${world.sha}.tar.gz.sha256`), "utf8"))
      .toBe(`${sha256(tarball)}  node-${world.sha}.tar.gz\n`);
  });

  it("refuses a bundle whose sha256 does not match the sidecar", async () => {
    const world = await makeWorld();
    temporaryRoots.push(world.root);
    const server = await startReleaseServer();
    const name = `node-${world.sha}.tar.gz`;
    server.assets.set(`${name}.sha256`, { body: `${"0".repeat(64)}  ${name}\n` });
    server.assets.set(name, { body: makeBundle(world.sha), redirect: true });

    const result = await runFetch(world, { baseUrl: server.url });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("sha256");
    await expect(stat(world.installDir)).rejects.toThrow();
    expect(await readdir(world.cacheDir)).not.toContain(name);
  });

  it("refuses an archive that writes outside the install directory", async () => {
    const world = await makeWorld();
    temporaryRoots.push(world.root);
    const server = await startReleaseServer();
    publish(server, world.sha, makeBundle(world.sha, { parentPath: true }));

    const result = await runFetch(world, { baseUrl: server.url });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("안전하지 않은 경로");
    await expect(stat(join(world.serviceDir, "escape.txt"))).rejects.toThrow();
  });

  it("refuses an archive that contains a symbolic link", async () => {
    const world = await makeWorld();
    temporaryRoots.push(world.root);
    const server = await startReleaseServer();
    publish(server, world.sha, makeBundle(world.sha, { symlink: true }));

    const result = await runFetch(world, { baseUrl: server.url });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("허용하지 않는 링크");
    await expect(stat(world.installDir)).rejects.toThrow();
  });

  it("waits for a sidecar that appears late", async () => {
    const world = await makeWorld();
    temporaryRoots.push(world.root);
    const server = await startReleaseServer();
    publish(server, world.sha, makeBundle(world.sha), { lateSidecarMs: 1500 });

    const result = await runFetch(world, { baseUrl: server.url, waitSec: 8 });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("sidecar ready after");
    const sidecarRequests = server.requests
      .filter((request) => request.endsWith(".tar.gz.sha256"));
    expect(sidecarRequests.length).toBeGreaterThanOrEqual(2);
    expect(result.stdout).toContain("fetch-node-bundle: source download");
  });

  it("fails when the sidecar never appears within --wait-sec", async () => {
    const world = await makeWorld();
    temporaryRoots.push(world.root);
    const server = await startReleaseServer();

    const result = await runFetch(world, { baseUrl: server.url, waitSec: 1 });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("timed out after 1s");
    expect(server.requests.length).toBeGreaterThanOrEqual(1);
    await expect(stat(world.installDir)).rejects.toThrow();
  });

  it("reuses the cached bundle without the server", async () => {
    const world = await makeWorld();
    temporaryRoots.push(world.root);
    const server = await startReleaseServer();
    publish(server, world.sha, makeBundle(world.sha));
    expect((await runFetch(world, { baseUrl: server.url })).code).toBe(0);
    const requestCount = server.requests.length;
    await server.close();
    servers.splice(servers.indexOf(server), 1);

    const result = await runFetch(world, { baseUrl: server.url, waitSec: 1 });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("fetch-node-bundle: source cache");
    expect(server.requests.length).toBe(requestCount);
  });

  it("refuses a bundle whose source_commit differs from HEAD", async () => {
    const world = await makeWorld();
    temporaryRoots.push(world.root);
    const server = await startReleaseServer();
    publish(server, world.sha, makeBundle(world.sha, { metadataCommit: "f".repeat(40) }));

    const result = await runFetch(world, { baseUrl: server.url });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("source_commit");
    await expect(stat(world.installDir)).rejects.toThrow();
  });

  it("keeps the existing dist when the fetch fails", async () => {
    const world = await makeWorld();
    temporaryRoots.push(world.root);
    await mkdir(world.installDir, { recursive: true });
    await writeFile(join(world.installDir, "main.js"), "// previous build\n");
    const server = await startReleaseServer();

    const result = await runFetch(world, { baseUrl: server.url, waitSec: 1 });
    expect(result.code).not.toBe(0);
    expect(await readFile(join(world.installDir, "main.js"), "utf8")).toBe("// previous build\n");
    await expect(stat(join(world.installDir, "release-manifest.json"))).rejects.toThrow();
  });

  it("prunes the cache to --keep while keeping HEAD's bundle", async () => {
    const world = await makeWorld();
    temporaryRoots.push(world.root);
    await mkdir(world.cacheDir, { recursive: true });
    const headBundle = makeBundle(world.sha);
    await writeCacheEntry(world.cacheDir, world.sha, headBundle);
    const older = ["a".repeat(40), "b".repeat(40)];
    for (const [index, sha] of older.entries()) {
      await writeCacheEntry(world.cacheDir, sha, Buffer.from(`old-${sha}`));
      await setMtime(world.cacheDir, sha, Date.now() - (3 - index) * 3600_000);
    }
    // HEAD의 보관본을 가장 오래된 것으로 만들어, 개수 정리와 별개로 남는지 본다.
    await setMtime(world.cacheDir, world.sha, Date.now() - 5 * 3600_000);

    const result = await runFetch(world, {
      baseUrl: "http://127.0.0.1:1",
      waitSec: 1,
      extraArgs: ["--keep", "1"],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("fetch-node-bundle: source cache");

    const remaining = await readdir(world.cacheDir);
    expect(remaining).toContain(`node-${world.sha}.tar.gz`);
    expect(remaining).toContain(`node-${older[1]}.tar.gz`);
    expect(remaining).not.toContain(`node-${older[0]}.tar.gz`);
    expect(remaining).not.toContain(`node-${older[0]}.tar.gz.sha256`);
  });

  it("rejects unknown arguments and missing required arguments", async () => {
    const world = await makeWorld();
    temporaryRoots.push(world.root);

    const unknown = await runProcess(process.execPath, [
      scriptPath,
      "--checkout", world.checkout,
      "--bogus", "x",
    ]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("unknown argument: --bogus");

    const missing = await runProcess(process.execPath, [scriptPath, "--checkout", world.checkout]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("--install-dir is required");
  });
});

type World = {
  root: string;
  checkout: string;
  sha: string;
  cacheDir: string;
  serviceDir: string;
  installDir: string;
  envFile: string;
};

async function makeWorld(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "fetch-node-bundle-"));
  const checkout = join(root, "checkout");
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, "README.md"), "checkout\n");
  await git(checkout, ["init", "--quiet", "-b", "main"]);
  await git(checkout, ["config", "user.email", "test@example.invalid"]);
  await git(checkout, ["config", "user.name", "fetch bundle test"]);
  await git(checkout, ["add", "-A"]);
  await git(checkout, ["commit", "--quiet", "-m", "fixture"]);
  const sha = (await git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
  const serviceDir = join(root, "service");
  const installDir = join(serviceDir, "soul-server-ts", "dist");
  await mkdir(serviceDir, { recursive: true });
  const envFile = join(serviceDir, ".env.soul-server-ts");
  await writeFile(envFile, "SOULSTREAM_NODE_ID=fetch-bundle-test\n");
  return { root, checkout, sha, cacheDir: join(root, "cache"), serviceDir, installDir, envFile };
}

async function runFetch(
  world: World,
  { baseUrl, waitSec = 6, extraArgs = [] }:
    { baseUrl?: string; waitSec?: number; extraArgs?: string[] } = {},
) {
  return runProcess(process.execPath, [
    scriptPath,
    "--checkout", world.checkout,
    "--install-dir", world.installDir,
    "--env-file", world.envFile,
    "--cache-dir", world.cacheDir,
    "--repo", "test/repo",
    "--tag", "node-bundles",
    "--wait-sec", String(waitSec),
    ...(baseUrl ? ["--base-url", baseUrl] : []),
    ...extraArgs,
  ]);
}

async function writeCacheEntry(cacheDir: string, sha: string, tarball: Buffer) {
  const name = `node-${sha}.tar.gz`;
  await writeFile(join(cacheDir, name), tarball);
  await writeFile(join(cacheDir, `${name}.sha256`), `${sha256(tarball)}  ${name}\n`);
}

async function setMtime(cacheDir: string, sha: string, when: number) {
  const date = new Date(when);
  for (const suffix of ["", ".sha256"]) {
    await utimes(join(cacheDir, `node-${sha}.tar.gz${suffix}`), date, date);
  }
}

type Asset = { body: Buffer | string; availableAt?: number; redirect?: boolean };

type ReleaseServer = {
  url: string;
  assets: Map<string, Asset>;
  requests: string[];
  close: () => Promise<void>;
};

async function startReleaseServer(): Promise<ReleaseServer> {
  const assets = new Map<string, Asset>();
  const requests: string[] = [];
  let port = 0;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.headers.host ?? ""}${url.pathname}`);
    if (url.pathname.startsWith("/blob/")) {
      const asset = assets.get(url.pathname.slice("/blob/".length));
      if (!asset) {
        response.writeHead(404);
        response.end("missing");
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(asset.body);
      return;
    }
    const name = url.pathname.split("/").pop() ?? "";
    const asset = assets.get(name);
    if (!asset || (asset.availableAt !== undefined && Date.now() < asset.availableAt)) {
      response.writeHead(404);
      response.end("missing");
      return;
    }
    if (asset.redirect) {
      // 다른 호스트(127.0.0.2)로 보내 redirect-follow를 실제로 태운다.
      response.writeHead(302, { location: `http://127.0.0.2:${port}/blob/${name}` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(asset.body);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "0.0.0.0", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("release server has no port");
  port = address.port;
  const handle: ReleaseServer = {
    url: `http://127.0.0.1:${port}`,
    assets,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
  servers.push(handle);
  return handle;
}

function publish(
  server: ReleaseServer,
  sha: string,
  tarball: Buffer,
  { lateSidecarMs = 0 }: { lateSidecarMs?: number } = {},
) {
  const name = `node-${sha}.tar.gz`;
  server.assets.set(`${name}.sha256`, {
    body: `${sha256(tarball)}  ${name}\n`,
    ...(lateSidecarMs > 0 ? { availableAt: Date.now() + lateSidecarMs } : {}),
  });
  server.assets.set(name, { body: tarball, redirect: true });
}

type TarEntry = { name: string; content?: string; type?: string; linkname?: string };

/** ustar 형식 tar.gz를 손으로 만든다. 심볼릭 링크(type 2)와 `..` 항목을 OS와 무관하게 심을 수 있다. */
function makeTarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content ?? "";
    const type = entry.type ?? "0";
    const size = type === "2" ? 0 : Buffer.byteLength(content);
    blocks.push(tarHeader({ name: entry.name, size, type, linkname: entry.linkname ?? "" }));
    if (size > 0) {
      const data = Buffer.alloc(Math.ceil(size / 512) * 512);
      Buffer.from(content).copy(data);
      blocks.push(data);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function tarHeader({ name, size, type, linkname }: { name: string; size: number; type: string; linkname: string }) {
  const header = Buffer.alloc(512);
  const write = (value: string, offset: number, length: number) => {
    Buffer.from(value, "utf8").copy(header, offset, 0, Math.min(length, Buffer.byteLength(value)));
  };
  write(name, 0, 100);
  write("0000644\0", 100, 8);
  write("0000000\0", 108, 8);
  write("0000000\0", 116, 8);
  write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, 12);
  write("        ", 148, 8);
  write(type, 156, 1);
  write(linkname, 157, 100);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function makeBundle(
  sourceCommit: string,
  { symlink = false, parentPath = false, metadataCommit = sourceCommit }:
    { symlink?: boolean; parentPath?: boolean; metadataCommit?: string } = {},
): Buffer {
  const metadata = {
    schema_version: 1,
    source_commit: metadataCommit,
    schema_generation: "schema-generation:fixture",
    wire_generation: `sha256-${"0".repeat(64)}`,
    files: [],
  };
  const entries: TarEntry[] = [
    { name: "./main.js", content: "// fixture main\n" },
    { name: "./bind-release.mjs", content: fakeBindScript() },
    { name: "./portable-release.json", content: `${JSON.stringify(metadata)}\n` },
  ];
  if (parentPath) entries.push({ name: "../escape.txt", content: "escaped\n" });
  if (symlink) entries.push({ name: "./link", type: "2", linkname: "/etc/passwd" });
  return makeTarGz(entries);
}

function fakeBindScript(): string {
  return [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const args = process.argv.slice(2);",
    'const value = (name) => args[args.indexOf(name) + 1];',
    'const releaseDir = value("--release-dir");',
    'if (!releaseDir || !value("--env-file") || !value("--catalog-path")) {',
    '  process.stderr.write("bind-release: usage\\n");',
    "  process.exit(1);",
    "}",
    'writeFileSync(join(releaseDir, "release-manifest.json"), JSON.stringify({ schema_version: 1 }));',
    'process.stdout.write("bind-release: bound fixture\\n");',
    "",
  ].join("\n");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd: string, args: string[]) {
  return runProcess("git", ["-C", cwd, ...args]).then((result) => {
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result;
  });
}

function runProcess(command: string, args: string[], { timeoutMs = 60000 } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}
