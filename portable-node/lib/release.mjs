// 500줄을 넘기는 이유: 런타임 잠금·다운로드·P3 payload 검증·압축 안전·bind가 하나의 계약을
// 이루고, 조각을 나누면 P3 소스와의 기계 대조(contract.test.mjs)가 흩어진다.
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { downloadFile, fetchJson, makeExecutable, sha256File } from "./download.mjs";
import { platformKey } from "./config.mjs";
import { run } from "./git.mjs";

export class ReleaseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ReleaseError";
    this.code = code;
  }
}

export const RUNTIME_KINDS = ["node", "claude", "codex", "python"];

// 아래 이름·값은 P3(soul-server-ts/src/release, src/runner)의 계약을 그대로 따른다.
export const PORTABLE_RELEASE_METADATA_FILE = "portable-release.json";
export const PORTABLE_BIND_SCRIPT_FILE = "bind-release.mjs";
export const PORTABLE_RUNNER_DIRECTORY = "runner";

/** P3 release_artifacts.ts의 HOST_RELEASE_ARTIFACTS와 같다. */
export const HOST_RELEASE_ARTIFACTS = [
  "main.js",
  "runner/runner_parent_storage_worker_entry.js",
  "runner/runner_release_prewarm.js",
  "upstream/control_inbox_worker_entry.js",
];

/** P3 runner_release_materializer.ts의 RUNNER_RELEASE_ARTIFACTS와 같다. */
export const RUNNER_RELEASE_ARTIFACTS = [
  "package.json",
  "runner_entry.js",
  "session-netns-helper.py",
  "session_netns_network.py",
];

/** P3 portable_release.ts의 BOUND_RELEASE_EXTRA_FILES와 같다. payload에 있어도 설명에 안 적히는 파일. */
export const BOUND_RELEASE_EXTRA_FILES = [
  PORTABLE_RELEASE_METADATA_FILE,
  "release-manifest.json",
  ".env.soul-server-ts",
];

/** P3 verifyPortableReleasePayload가 요구하는 최소 파일 목록. */
export const PAYLOAD_REQUIRED_FILES = [
  ...HOST_RELEASE_ARTIFACTS,
  ...RUNNER_RELEASE_ARTIFACTS.map((name) => `${PORTABLE_RUNNER_DIRECTORY}/${name}`),
  PORTABLE_BIND_SCRIPT_FILE,
];

export const SHA256_PATTERN = /^sha256-[0-9a-f]{64}$/;

/** P3 parsePortableReleaseMetadata의 requireExactKeys 목록과 같다. */
export const METADATA_KEYS = ["schema_version", "source_commit", "schema_generation", "wire_generation", "files"];
export const FILE_KEYS = ["path", "sha256", "size"];

export async function readRuntimeLock(portableDir) {
  const raw = await readFile(join(portableDir, "runtime-lock.json"), "utf8");
  const lock = JSON.parse(raw);
  if (lock.schema_version !== 1 || !lock.runtimes) {
    throw new ReleaseError("runtime-lock.json 형식이 올바르지 않습니다.", "LOCK_INVALID");
  }
  return lock;
}

export function runtimePlan(lock, key) {
  const plan = [];
  for (const kind of RUNTIME_KINDS) {
    const runtime = lock.runtimes[kind];
    if (!runtime) throw new ReleaseError(`runtime-lock.json에 ${kind}가 없습니다.`, "LOCK_INVALID");
    const entry = runtime.platforms?.[key];
    if (!entry) {
      throw new ReleaseError(
        `이 플랫폼(${key})용 ${kind} ${runtime.version} 배포본이 잠금 파일에 없습니다.`,
        "LOCK_PLATFORM_MISSING",
      );
    }
    plan.push({ kind, version: runtime.version, ...entry });
  }
  return plan;
}

export function runtimeInstallDir(stateRoot, kind, version) {
  return join(stateRoot, "runtimes", kind, version, platformKey());
}

export async function readRuntimeMarker(dir) {
  try {
    return JSON.parse(await readFile(join(dir, ".portable-runtime.json"), "utf8"));
  } catch {
    return null;
  }
}

/** 설치 기록과 실행 파일이 모두 맞을 때만 그 런타임을 다시 쓰지 않는다. */
export async function runtimeReady({ dir, entry }) {
  const marker = await readRuntimeMarker(dir);
  if (!marker || marker.sha256 !== entry.sha256) return false;
  try {
    await stat(join(dir, entry.executable));
    return true;
  } catch {
    return false;
  }
}

/** child가 parent 안(자기 자신 포함)에 있는지 실제 경로로 판정한다. */
export async function isPathInside(parent, child) {
  let parentReal;
  let childReal;
  try {
    parentReal = await realpath(parent);
  } catch {
    return false;
  }
  try {
    childReal = await realpath(child);
  } catch {
    childReal = resolve(child);
  }
  const rel = relative(parentReal, childReal);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * 압축 항목의 경로가 폴더 밖을 가리키면 안전하지 않다.
 * 절대 경로, 드라이브 문자, `..` 조각을 모두 막는다.
 */
function isUnsafeArchivePath(path) {
  const normalized = String(path).replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return true;
  return normalized.split("/").includes("..");
}

/** 상대 링크 대상이 그 항목의 위치에서 압축 루트 밖으로 나가는지 본다. */
function linkTargetEscapes(entryPath, target) {
  if (!target) return true;
  const normalizedTarget = String(target).replace(/\\/g, "/");
  if (normalizedTarget.startsWith("/") || /^[A-Za-z]:\//.test(normalizedTarget)) return true;
  const base = posix.dirname(String(entryPath).replace(/\\/g, "/"));
  const resolved = posix.normalize(posix.join(base, normalizedTarget));
  return resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/");
}

function parseTarVerboseLine(line) {
  const type = line.length > 0 ? line[0] : "";
  let target = null;
  if (type === "l") {
    const index = line.lastIndexOf(" -> ");
    if (index >= 0) target = line.slice(index + 4);
  } else if (type === "h") {
    const index = line.lastIndexOf(" link to ");
    if (index >= 0) target = line.slice(index + 8);
  }
  return { type, target };
}

async function listZipEntries(archivePath) {
  if (process.platform === "win32") {
    const escaped = archivePath.replace(/'/g, "''");
    const script =
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
      `$zip = [System.IO.Compression.ZipFile]::OpenRead('${escaped}'); ` +
      "try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }";
    const result = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeoutMs: 120000,
    });
    if (result.code !== 0) {
      throw new ReleaseError(`압축 목록을 읽지 못했습니다: ${result.stderr.trim()}`, "EXTRACT_FAILED");
    }
    return result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  }
  const result = await run("unzip", ["-Z1", archivePath], { timeoutMs: 120000 });
  if (result.code !== 0) {
    throw new ReleaseError(`압축 목록을 읽지 못했습니다: ${result.stderr.trim()}`, "EXTRACT_FAILED");
  }
  return result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

/**
 * 풀기 전에 항목을 검사해 폴더 밖 쓰기와 링크 탈출을 막는다.
 * allowInternalLinks가 false인 앱 묶음은 링크 항목 자체를 거부한다.
 * 런타임은 자기 폴더 안을 가리키는 상대 링크만 허용한다(Node의 bin/npm 등).
 */
async function assertSafeArchive(archivePath, {
  archive,
  allowInternalLinks,
  label,
  stateRoot,
}) {
  const reject = (message) => {
    throw new ReleaseError(`${label}에 ${message}`, "UNSAFE_ARCHIVE");
  };
  if (archive === "tar.gz") {
    const pathsResult = await run("tar", ["-tzf", archivePath], {
      env: { ...process.env, HOME: join(stateRoot, "home") },
      timeoutMs: 600000,
    });
    if (pathsResult.code !== 0) {
      throw new ReleaseError(`압축 목록을 읽지 못했습니다: ${pathsResult.stderr.trim()}`, "EXTRACT_FAILED");
    }
    const paths = pathsResult.stdout.split("\n").filter((line) => line.length > 0);
    for (const path of paths) {
      if (isUnsafeArchivePath(path)) reject(`안전하지 않은 경로가 있습니다: ${path}`);
    }
    const verboseResult = await run("tar", ["-tvzf", archivePath], {
      env: { ...process.env, HOME: join(stateRoot, "home") },
      timeoutMs: 600000,
    });
    if (verboseResult.code !== 0) {
      throw new ReleaseError(`압축 목록을 읽지 못했습니다: ${verboseResult.stderr.trim()}`, "EXTRACT_FAILED");
    }
    const verbose = verboseResult.stdout.split(/\r?\n/).filter((line) => line.length > 0);
    verbose.forEach((line, index) => {
      const { type, target } = parseTarVerboseLine(line);
      if (type === "l" || type === "h") {
        if (!allowInternalLinks) reject(`허용하지 않는 링크 항목이 있습니다: ${paths[index] ?? line}`);
        if (type === "l") {
          if (linkTargetEscapes(paths[index] ?? "", target)) {
            reject(`링크가 폴더 밖을 가리킵니다: ${paths[index]} -> ${target}`);
          }
        } else if (isUnsafeArchivePath(target ?? "")) {
          reject(`링크가 폴더 밖을 가리킵니다: ${paths[index]} -> ${target}`);
        }
        return;
      }
      if (!["-", "d"].includes(type)) reject(`허용하지 않는 항목 형식이 있습니다: ${paths[index] ?? line}`);
    });
    return;
  }
  if (archive === "zip") {
    for (const path of await listZipEntries(archivePath)) {
      if (isUnsafeArchivePath(path)) reject(`안전하지 않은 경로가 있습니다: ${path}`);
    }
  }
}

/** 풀린 뒤 실제 링크 대상이 런타임 폴더 안에 있는지 다시 확인한다. */
async function assertLinksInside(rootDir) {
  const rootReal = await realpath(rootDir);
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        let target;
        try {
          target = await realpath(path);
        } catch {
          throw new ReleaseError(`압축을 푼 링크가 끊어져 있습니다: ${path}`, "UNSAFE_ARCHIVE");
        }
        if (target !== rootReal && !target.startsWith(rootReal + sep)) {
          throw new ReleaseError(`압축을 푼 링크가 폴더 밖을 가리킵니다: ${path}`, "UNSAFE_ARCHIVE");
        }
        continue;
      }
      if (info.isDirectory()) await walk(path);
    }
  };
  await walk(rootDir);
}

async function extractArchive({ archivePath, archive, destination, stateRoot }) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  if (archive === "tar.gz") {
    const result = await run("tar", ["-xzf", archivePath, "-C", destination], {
      env: { ...process.env, HOME: join(stateRoot, "home") },
      timeoutMs: 1200000,
    });
    if (result.code !== 0) {
      throw new ReleaseError(`압축을 풀지 못했습니다: ${result.stderr.trim()}`, "EXTRACT_FAILED");
    }
    return;
  }
  if (archive === "zip") {
    if (process.platform === "win32") {
      const result = await run(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destination}' -Force`],
        { timeoutMs: 1200000 },
      );
      if (result.code !== 0) {
        throw new ReleaseError(`압축을 풀지 못했습니다: ${result.stderr.trim()}`, "EXTRACT_FAILED");
      }
      return;
    }
    const result = await run("unzip", ["-q", archivePath, "-d", destination], { timeoutMs: 1200000 });
    if (result.code !== 0) {
      throw new ReleaseError(`압축을 풀지 못했습니다: ${result.stderr.trim()}`, "EXTRACT_FAILED");
    }
    return;
  }
  throw new ReleaseError(`알 수 없는 압축 형식입니다: ${archive}`, "EXTRACT_FAILED");
}

/** 최상위 폴더 하나만 있는 배포본은 그 안쪽을 설치 루트로 삼는다. */
async function normalizeSingleDirectory(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) return join(dir, entries[0].name);
  return dir;
}

export async function ensureRuntime({ stateRoot, plan, kind, log = () => {} }) {
  const entry = plan.find((item) => item.kind === kind);
  if (!entry) throw new ReleaseError(`런타임 계획에 ${kind}가 없습니다.`, "RUNTIME_PLAN");
  const dir = runtimeInstallDir(stateRoot, kind, entry.version);
  if (await runtimeReady({ dir, entry })) {
    return { kind, dir, version: entry.version, installed: false, executable: join(dir, entry.executable) };
  }
  if (await isPathInside(dir, process.execPath)) {
    throw new ReleaseError(
      `현재 실행 중인 ${kind} 런타임 폴더는 지우거나 바꾸지 않습니다. 실행기를 다시 시작해 새 런타임을 준비하십시오.`,
      "RUNTIME_IN_USE",
    );
  }

  log(`${kind} ${entry.version} 내려받는 중…`);
  const downloadDir = join(stateRoot, "cache", "downloads");
  const archiveName = entry.url.split("/").pop().split("?")[0];
  const archivePath = join(downloadDir, archiveName);
  await downloadFile(entry.url, archivePath, {
    expectedSha256: entry.sha256,
    onProgress: ({ bytes }) => log(`${kind} ${entry.version}: ${Math.round(bytes / 1048576)}MiB`),
  });
  await assertSafeArchive(archivePath, {
    archive: entry.archive,
    allowInternalLinks: true,
    label: "런타임 압축",
    stateRoot,
  });

  await rm(dir, { recursive: true, force: true });
  await mkdir(dirname(dir), { recursive: true });
  if (entry.archive === "binary") {
    await mkdir(dir, { recursive: true });
    const target = join(dir, entry.executable);
    await cp(archivePath, target);
    await makeExecutable(target);
  } else {
    const tempDir = join(stateRoot, "cache", "extract", `${kind}-${entry.version.replace(/[^\w.-]/g, "_")}`);
    await extractArchive({ archivePath, archive: entry.archive, destination: tempDir, stateRoot });
    const root = await normalizeSingleDirectory(tempDir);
    await assertLinksInside(root);
    await rename(root, dir);
    await rm(tempDir, { recursive: true, force: true });
    await makeExecutable(join(dir, entry.executable));
  }
  await writeFile(
    join(dir, ".portable-runtime.json"),
    `${JSON.stringify({ kind, version: entry.version, sha256: entry.sha256, installed_at: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { kind, dir, version: entry.version, installed: true, executable: join(dir, entry.executable) };
}

export async function ensureAllRuntimes({ stateRoot, lock, log = () => {} }) {
  const key = platformKey();
  const plan = runtimePlan(lock, key);
  const results = {};
  for (const entry of plan) {
    results[entry.kind] = await ensureRuntime({ stateRoot, plan, kind: entry.kind, log });
  }
  return results;
}

/** 검증 기록은 payload 밖에 둔다. payload 안에 두면 P3 bind가 미등록 파일로 거부한다. */
export function releaseMarkerPath(stateRoot, sourceCommit) {
  return join(stateRoot, "releases", `${sourceCommit}.verified.json`);
}

export async function fetchCurrentRelease({ upstream, token, timeoutMs = 15000, fetchJsonImpl = fetchJson }) {
  const url = new URL("/api/node/releases/current", upstream).toString();
  const response = await fetchJsonImpl(url, {
    headers: { authorization: `Bearer ${token}` },
    timeoutMs,
  });
  if (response.status === 401) {
    throw new ReleaseError("노드 자격 증명이 취소되었습니다. 관리자에게 다시 참여를 요청하십시오.", "REVOKED");
  }
  if (response.status === 503) {
    throw new ReleaseError("아직 내려받을 앱 묶음이 준비되지 않았습니다. 잠시 뒤 다시 확인합니다.", "NOT_READY");
  }
  if (!response.ok || !response.body || typeof response.body !== "object") {
    throw new ReleaseError(`릴리스 정보를 받지 못했습니다 (${response.status}).`, "RELEASE_FETCH_FAILED");
  }
  const body = response.body;
  if (body.contract_version !== 1) {
    throw new ReleaseError(`알 수 없는 릴리스 계약입니다 (${body.contract_version}).`, "CONTRACT_UNSUPPORTED");
  }
  for (const field of ["source_commit", "sha256", "download_path"]) {
    if (!body[field]) throw new ReleaseError(`릴리스 응답에 ${field}가 없습니다.`, "RELEASE_MALFORMED");
  }
  if (typeof body.sha256 !== "string" || !SHA256_PATTERN.test(body.sha256)) {
    throw new ReleaseError(`릴리스 응답의 sha256 형식이 올바르지 않습니다 (${body.sha256}).`, "RELEASE_MALFORMED");
  }
  return body;
}

/** 릴리스 응답의 sha256은 `sha256-<hex>`다. 내려받기 검증과 키에는 hex 부분만 쓴다. */
function sha256Hex(value) {
  return String(value).replace(/^sha256-/, "");
}

export function releaseKey(release) {
  return `${String(release.source_commit).slice(0, 12)}-${sha256Hex(release.sha256).slice(0, 12)}`;
}

export function releaseDir(stateRoot, release) {
  return join(stateRoot, "releases", release.source_commit);
}

function requireExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ReleaseError(`${label}의 항목이 올바르지 않습니다.`, "PAYLOAD_MALFORMED");
  }
}

/** P3 payloadPath와 같은 규칙. 백슬래시·NUL·절대 경로·드라이브·`..`·정규화 불일치를 거부한다. */
function payloadPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleaseError("앱 묶음 파일 경로가 올바르지 않습니다.", "PAYLOAD_MALFORMED");
  }
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new ReleaseError(`앱 묶음에 안전하지 않은 경로가 있습니다: ${value}`, "PAYLOAD_MALFORMED");
  }
  if (value === "." || value === ".." || value.startsWith("../") || posix.normalize(value) !== value) {
    throw new ReleaseError(`앱 묶음에 안전하지 않은 경로가 있습니다: ${value}`, "PAYLOAD_MALFORMED");
  }
  return value;
}

/** P3 listPortablePayloadFiles와 같이 디렉터리를 걸어 내려가며 링크·특수 파일을 거부한다. */
async function listPayloadFiles(dir, prefix = "") {
  const found = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new ReleaseError(`앱 묶음에 허용하지 않는 파일 형식이 있습니다: ${name}`, "PAYLOAD_MALFORMED");
    }
    if (entry.isDirectory()) found.push(...(await listPayloadFiles(dir, name)));
    else found.push(name);
  }
  return found;
}

async function validatePayload(payloadDir, release) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(payloadDir, PORTABLE_RELEASE_METADATA_FILE), "utf8"));
  } catch (error) {
    throw new ReleaseError(`앱 묶음 설명을 읽지 못했습니다: ${error.message}`, "PAYLOAD_MALFORMED");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ReleaseError("앱 묶음 설명이 객체가 아닙니다.", "PAYLOAD_MALFORMED");
  }
  requireExactKeys(manifest, METADATA_KEYS, "앱 묶음 설명");
  if (manifest.schema_version !== 1) {
    throw new ReleaseError("앱 묶음 설명의 schema_version이 1이 아닙니다.", "PAYLOAD_MALFORMED");
  }
  for (const key of ["source_commit", "schema_generation", "wire_generation"]) {
    if (typeof manifest[key] !== "string" || manifest[key].length === 0) {
      throw new ReleaseError(`앱 묶음 설명의 ${key}가 올바르지 않습니다.`, "PAYLOAD_MALFORMED");
    }
  }
  if (manifest.source_commit !== release.source_commit) {
    throw new ReleaseError("앱 묶음의 커밋이 릴리스 정보와 다릅니다.", "PAYLOAD_MISMATCH");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new ReleaseError("앱 묶음 설명에 파일 목록이 없습니다.", "PAYLOAD_MALFORMED");
  }
  const fileNames = new Set();
  for (const entry of manifest.files) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ReleaseError("앱 묶음 파일 항목이 올바르지 않습니다.", "PAYLOAD_MALFORMED");
    }
    requireExactKeys(entry, FILE_KEYS, "앱 묶음 파일 항목");
    const relativePath = payloadPath(entry.path);
    if (fileNames.has(relativePath)) {
      throw new ReleaseError(`앱 묶음 설명에 같은 파일이 두 번 있습니다: ${relativePath}`, "PAYLOAD_MALFORMED");
    }
    if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
      throw new ReleaseError(`앱 묶음 파일 해시 형식이 올바르지 않습니다: ${relativePath}`, "PAYLOAD_MALFORMED");
    }
    if (!Number.isInteger(entry.size) || entry.size < 0) {
      throw new ReleaseError(`앱 묶음 파일 크기가 올바르지 않습니다: ${relativePath}`, "PAYLOAD_MALFORMED");
    }
    const target = join(payloadDir, relativePath);
    let digest;
    try {
      digest = await sha256File(target);
    } catch {
      throw new ReleaseError(`앱 묶음에 파일이 없습니다: ${relativePath}`, "PAYLOAD_INCOMPLETE");
    }
    if (`sha256-${digest}` !== entry.sha256) {
      throw new ReleaseError(`앱 묶음 파일 해시가 다릅니다: ${relativePath}`, "PAYLOAD_MISMATCH");
    }
    if ((await stat(target)).size !== entry.size) {
      throw new ReleaseError(`앱 묶음 파일 크기가 다릅니다: ${relativePath}`, "PAYLOAD_MISMATCH");
    }
    fileNames.add(relativePath);
  }
  for (const required of PAYLOAD_REQUIRED_FILES) {
    if (!fileNames.has(required)) {
      throw new ReleaseError(`앱 묶음에 필요한 파일이 없습니다: ${required}`, "PAYLOAD_INCOMPLETE");
    }
  }
  for (const actual of await listPayloadFiles(payloadDir)) {
    if (!fileNames.has(actual) && !BOUND_RELEASE_EXTRA_FILES.includes(actual)) {
      throw new ReleaseError(`앱 묶음에 설명에 없는 파일이 있습니다: ${actual}`, "PAYLOAD_MALFORMED");
    }
  }
  return manifest;
}

export async function installRelease({ stateRoot, upstream, token, release, log = () => {} }) {
  const target = releaseDir(stateRoot, release);
  const verifiedPath = releaseMarkerPath(stateRoot, release.source_commit);
  try {
    const marker = JSON.parse(await readFile(verifiedPath, "utf8"));
    if (marker.sha256 === release.sha256 && marker.key === releaseKey(release)) {
      await stat(join(target, PORTABLE_RELEASE_METADATA_FILE));
      return { dir: target, key: releaseKey(release), downloaded: false, release };
    }
  } catch {
    // 설치되지 않았거나 검증 기록이 없다. 새로 받는다.
  }

  log(`앱 묶음 ${releaseKey(release)} 내려받는 중…`);
  const bundleUrl = new URL(release.download_path, upstream).toString();
  const bundlePath = join(stateRoot, "cache", "downloads", `node-${releaseKey(release)}.tar.gz`);
  await downloadFile(bundleUrl, bundlePath, {
    headers: { authorization: `Bearer ${token}` },
    expectedSha256: sha256Hex(release.sha256),
    expectedSize: release.size,
    onProgress: ({ bytes }) => log(`앱 묶음: ${Math.round(bytes / 1048576)}MiB`),
  });

  const tempDir = join(stateRoot, "releases", `.tmp-${releaseKey(release)}-${process.pid}`);
  await assertSafeArchive(bundlePath, {
    archive: "tar.gz",
    allowInternalLinks: false,
    label: "앱 묶음",
    stateRoot,
  });
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  const extractResult = await run("tar", ["-xzf", bundlePath, "-C", tempDir], {
    env: { ...process.env, HOME: join(stateRoot, "home") },
    timeoutMs: 1800000,
  });
  if (extractResult.code !== 0) {
    await rm(tempDir, { recursive: true, force: true });
    throw new ReleaseError(`앱 묶음을 풀지 못했습니다: ${extractResult.stderr.trim()}`, "EXTRACT_FAILED");
  }
  const entries = await readdir(tempDir, { withFileTypes: true });
  const payloadRoot =
    entries.length === 1 && entries[0].isDirectory() ? join(tempDir, entries[0].name) : tempDir;
  await validatePayload(payloadRoot, release);

  await rm(target, { recursive: true, force: true });
  await mkdir(join(stateRoot, "releases"), { recursive: true });
  await rename(payloadRoot, target);
  await rm(tempDir, { recursive: true, force: true });
  await writeFile(
    verifiedPath,
    `${JSON.stringify(
      {
        key: releaseKey(release),
        sha256: release.sha256,
        source_commit: release.source_commit,
        verified_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { dir: target, key: releaseKey(release), downloaded: true, release };
}

export async function runBind({ releaseDir: dir, nodePath, envFile, env, catalogPath, timeoutMs = 300000 }) {
  const bindPath = join(dir, "bind-release.mjs");
  const result = await run(
    nodePath,
    [bindPath, "--release-dir", dir, "--env-file", envFile, "--catalog-path", catalogPath],
    {
      cwd: dir,
      env,
      timeoutMs,
    },
  );
  if (result.code !== 0) {
    throw new ReleaseError(
      `릴리스 바인딩이 실패했습니다 (${result.code}): ${result.stderr.trim().slice(0, 2000)}`,
      "BIND_FAILED",
    );
  }
  try {
    await stat(join(dir, "release-manifest.json"));
  } catch {
    throw new ReleaseError("바인딩 뒤에 release-manifest.json이 생기지 않았습니다.", "BIND_FAILED");
  }
  return { stderr: result.stderr };
}
