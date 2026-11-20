#!/usr/bin/env node
// 워커 post_pull용 GitHub Release 묶음 소비자.
// 체크아웃 HEAD의 node-<sha>.tar.gz를 보관 폴더나 GitHub Release에서 받아 sha256을 검증하고,
// 안전 검사를 거쳐 <install-dir>.next에 푼 뒤 그 자리에서 bind하고 dist와 자리를 바꾼다.
// 노드 빌드로 되돌아가는 분기는 두지 않는다. 어느 단계든 실패하면 0이 아닌 코드로 끝난다.
// bind에 --catalog-path를 넘기지 않는다: 오케스트레이터는 release_manifest의 12키 정확 일치만 받으므로
// model_catalog_path 키가 붙으면 등록이 거부된다(orch-server-ts/src/node/release_activation_registration.ts MANIFEST_KEYS).
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { downloadFile, sha256File } from "../../portable-node/lib/download.mjs";
import { assertSafeArchive, extractArchive } from "../../portable-node/lib/release.mjs";

const OPTION_KEYS = new Set([
  "checkout",
  "install-dir",
  "env-file",
  "cache-dir",
  "repo",
  "tag",
  "base-url",
  "wait-sec",
  "keep",
]);
const REQUIRED_KEYS = ["checkout", "install-dir", "env-file", "cache-dir"];

const startedAt = performance.now();
let stepLabel = "init";
let stepStart = performance.now();
const stepLines = [];
const warnings = [];

try {
  const options = parseOptions(process.argv.slice(2));

  mark("resolve");
  const sourceCommit = await headCommit(options.checkout);
  complete("resolve");

  mark("acquire");
  const acquired = await acquireBundle({ ...options, sha: sourceCommit });
  complete("acquire");

  mark("extract");
  const nextDir = `${options.installDir}.next`;
  await extractBundle({ tarballPath: acquired.tarballPath, nextDir, cacheDir: options.cacheDir });
  complete("extract");

  mark("verify");
  await assertSourceCommit(nextDir, sourceCommit);
  complete("verify");

  mark("bind");
  await bindRelease({ nextDir, envFile: options.envFile });
  complete("bind");

  mark("swap");
  await swapInstallDir({ installDir: options.installDir, nextDir, oldDir: `${options.installDir}.old` });
  complete("swap");

  mark("prune");
  await pruneCache({ cacheDir: options.cacheDir, keep: options.keep, keepSha: sourceCommit });
  complete("prune");

  process.stdout.write([
    `fetch-node-bundle: commit ${sourceCommit}`,
    `fetch-node-bundle: source ${acquired.source}`,
    `fetch-node-bundle: waited ${seconds(acquired.waitedMs)}s`,
    ...stepLines,
    ...warnings,
    `fetch-node-bundle: done ${seconds(performance.now() - startedAt)}s`,
  ].join("\n") + "\n");
} catch (error) {
  process.stderr.write(`fetch-node-bundle: ${stepLabel} failed: ${oneLine(error)}\n`);
  process.exitCode = 1;
}

function mark(label) {
  stepLabel = label;
  stepStart = performance.now();
}

function complete(label) {
  stepLines.push(`fetch-node-bundle: step ${label} ${seconds(performance.now() - stepStart)}s`);
}

function seconds(milliseconds) {
  return (milliseconds / 1000).toFixed(1);
}

function oneLine(value) {
  return String(value ?? "").replace(/\s*\n\s*/g, " | ").trim();
}

function parseOptions(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (typeof name !== "string" || !name.startsWith("--")) {
      throw new Error(`unknown argument: ${String(name)}`);
    }
    const key = name.slice(2);
    if (!OPTION_KEYS.has(key)) throw new Error(`unknown argument: --${key}`);
    if (values.has(key)) throw new Error(`duplicate argument: --${key}`);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    values.set(key, value);
  }
  for (const key of REQUIRED_KEYS) {
    if (!values.has(key)) throw new Error(`--${key} is required`);
  }
  return {
    checkout: resolve(values.get("checkout")),
    installDir: resolve(values.get("install-dir")),
    envFile: resolve(values.get("env-file")),
    cacheDir: resolve(values.get("cache-dir")),
    repo: values.get("repo") ?? "eiaserinnys/soulstream",
    tag: values.get("tag") ?? "node-bundles",
    baseUrl: (values.get("base-url") ?? "https://github.com").replace(/\/+$/, ""),
    waitSec: parseInteger(values.get("wait-sec") ?? "600", "--wait-sec", 0),
    keep: parseInteger(values.get("keep") ?? "5", "--keep", 1),
  };
}

function parseInteger(raw, label, minimum) {
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be an integer: ${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be >= ${minimum}: ${raw}`);
  }
  return value;
}

async function headCommit(checkout) {
  const result = await runProcess("git", ["-C", checkout, "rev-parse", "HEAD"], { timeoutMs: 60000 });
  if (result.code !== 0) {
    throw new Error(`git rev-parse HEAD exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`git rev-parse HEAD returned ${JSON.stringify(sha)}`);
  return sha;
}

async function acquireBundle({ cacheDir, repo, tag, baseUrl, sha, waitSec }) {
  await mkdir(cacheDir, { recursive: true });
  const fileName = `node-${sha}.tar.gz`;
  const tarballPath = join(cacheDir, fileName);
  const sidecarPath = `${tarballPath}.sha256`;
  if (await readCachedDigest(sidecarPath, tarballPath, fileName)) {
    return { tarballPath, source: "cache", waitedMs: 0 };
  }

  const releasePath = `${baseUrl}/${repo}/releases/download/${tag}`;
  const sidecar = await waitForSidecar(`${releasePath}/${fileName}.sha256`, waitSec);
  const expected = parseSidecar(sidecar.text, fileName);
  if (!expected) {
    throw new Error(`sidecar has an unexpected format: ${oneLine(sidecar.text).slice(0, 200)}`);
  }
  await downloadFile(`${releasePath}/${fileName}`, tarballPath, {
    expectedSha256: expected,
    timeoutMs: 600000,
  });
  await writeFileAtomic(sidecarPath, `${expected}  ${fileName}\n`);
  return { tarballPath, source: "download", waitedMs: sidecar.waitedMs };
}

async function readCachedDigest(sidecarPath, tarballPath, fileName) {
  try {
    const expected = parseSidecar(await readFile(sidecarPath, "utf8"), fileName);
    if (!expected) return null;
    return (await sha256File(tarballPath)) === expected ? expected : null;
  } catch {
    return null;
  }
}

function parseSidecar(text, fileName) {
  const match = /^([0-9a-f]{64})[ \t]+(\S+)\s*$/.exec(String(text).trim());
  if (!match || match[2] !== fileName) return null;
  return match[1];
}

async function writeFileAtomic(path, text) {
  const temporary = `${path}.part-${process.pid}`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

async function waitForSidecar(url, waitSec) {
  const waitStartedAt = Date.now();
  const deadline = waitStartedAt + waitSec * 1000;
  const intervalMs = Math.max(1000, Math.min(10000, Math.ceil(Math.max(waitSec, 1) / 12) * 1000));
  let attempt = 0;
  let lastProblem = "not fetched yet";
  for (;;) {
    attempt += 1;
    const remainingMs = deadline - Date.now();
    if (attempt > 1 && remainingMs <= 0) break;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(15000, Math.max(1000, remainingMs))),
      });
      if (response.ok) {
        const text = await response.text();
        if (attempt > 1) {
          process.stdout.write(`fetch-node-bundle: sidecar ready after ${attempt} attempts\n`);
        }
        return { text, waitedMs: Date.now() - waitStartedAt };
      }
      lastProblem = `HTTP ${response.status}`;
      await response.body?.cancel();
    } catch (error) {
      lastProblem = error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "timeout"
        : (error?.message ?? String(error));
    }
    const sleepMs = Math.min(intervalMs, deadline - Date.now());
    process.stdout.write(
      `fetch-node-bundle: waiting for ${url} (attempt ${attempt}, ${lastProblem})\n`,
    );
    if (sleepMs <= 0) break;
    await delay(sleepMs);
  }
  throw new Error(`timed out after ${waitSec}s waiting for ${url} (last: ${lastProblem})`);
}

async function extractBundle({ tarballPath, nextDir, cacheDir }) {
  await assertSafeArchive(tarballPath, {
    archive: "tar.gz",
    allowInternalLinks: false,
    label: "워커 실행 묶음",
    stateRoot: cacheDir,
  });
  await extractArchive({
    archivePath: tarballPath,
    archive: "tar.gz",
    destination: nextDir,
    stateRoot: cacheDir,
  });
}

async function assertSourceCommit(nextDir, sha) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(nextDir, "portable-release.json"), "utf8"));
  } catch (error) {
    throw new Error(`portable-release.json is missing or invalid: ${oneLine(error)}`);
  }
  if (metadata?.source_commit !== sha) {
    throw new Error(
      `portable-release.json source_commit ${JSON.stringify(metadata?.source_commit)} does not match HEAD ${sha}`,
    );
  }
}

async function bindRelease({ nextDir, envFile }) {
  const result = await runProcess(process.execPath, [
    join(nextDir, "bind-release.mjs"),
    "--release-dir", nextDir,
    "--env-file", envFile,
  ], { cwd: nextDir, timeoutMs: 300000 });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(`bind-release.mjs exited ${result.code}: ${oneLine(detail).slice(0, 500)}`);
  }
}

async function swapInstallDir({ installDir, nextDir, oldDir }) {
  await rm(oldDir, { recursive: true, force: true });
  const hasInstallDir = await pathExists(installDir);
  if (hasInstallDir) await renameWithRetry(installDir, oldDir);
  try {
    await renameWithRetry(nextDir, installDir);
  } catch (error) {
    if (hasInstallDir) {
      await renameWithRetry(oldDir, installDir).catch((restoreError) => {
        warnings.push(`fetch-node-bundle: warning: could not restore ${installDir}: ${oneLine(restoreError)}`);
      });
    }
    throw error;
  }
  await rm(oldDir, { recursive: true, force: true }).catch((error) => {
    warnings.push(`fetch-node-bundle: warning: could not remove ${oldDir}: ${oneLine(error)}`);
  });
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if ((error?.code !== "EPERM" && error?.code !== "EBUSY") || attempt >= 4) throw error;
      await delay(200);
    }
  }
}

async function pruneCache({ cacheDir, keep, keepSha }) {
  let names;
  try {
    names = await readdir(cacheDir);
  } catch {
    return;
  }
  const groups = new Map();
  for (const name of names) {
    const match = /^node-([0-9a-f]{40})\.tar\.gz(\.sha256)?$/.exec(name);
    if (!match) continue;
    const sha = match[1];
    const group = groups.get(sha) ?? { sha, mtimeMs: 0, files: [] };
    group.files.push(name);
    try {
      group.mtimeMs = Math.max(group.mtimeMs, (await stat(join(cacheDir, name))).mtimeMs);
    } catch {
      // 정리 판정에만 쓰는 값이라 읽지 못하면 0으로 둔다.
    }
    groups.set(sha, group);
  }
  const ordered = [...groups.values()].sort((left, right) => right.mtimeMs - left.mtimeMs);
  const kept = new Set(ordered.slice(0, keep).map((group) => group.sha));
  kept.add(keepSha);
  for (const group of ordered) {
    if (kept.has(group.sha)) continue;
    for (const name of group.files) {
      await rm(join(cacheDir, name), { force: true }).catch((error) => {
        warnings.push(`fetch-node-bundle: warning: could not remove ${name}: ${oneLine(error)}`);
      });
    }
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function runProcess(command, args, { cwd, timeoutMs = 300000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
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
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, signal, stdout, stderr });
    });
  });
}
