// P3(soul-server-ts)가 정한 묶음 계약을 이 실행기의 상수와 fixture가 그대로 따르는지 기계적으로 대조한다.
// 실제 P3 묶음을 내려받아 하는 종단 확인은 P7에서 한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOUND_RELEASE_EXTRA_FILES,
  HOST_RELEASE_ARTIFACTS,
  FILE_KEYS,
  METADATA_KEYS,
  PAYLOAD_REQUIRED_FILES,
  PORTABLE_BIND_SCRIPT_FILE,
  PORTABLE_RELEASE_METADATA_FILE,
  PORTABLE_RUNNER_DIRECTORY,
  RUNNER_RELEASE_ARTIFACTS,
  SHA256_PATTERN,
  fetchCurrentRelease,
} from "../lib/release.mjs";
import {
  DARWIN_UNIX_SOCKET_PATH_MAX_BYTES,
  LINUX_UNIX_SOCKET_PATH_MAX_BYTES,
  RUNNER_SESSION_SLUG_LENGTH,
  RUNNER_SOCKET_FILE_NAME,
  runnerSocketPathByteLength,
} from "../lib/paths.mjs";
import { makeBundle, makeTempRoot } from "./helpers.mjs";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SERVER_SRC = join(REPO_ROOT, "soul-server-ts", "src");

function arrayLiteral(source, name) {
  const match = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(source);
  assert.ok(match, `${name} 배열을 P3 소스에서 찾지 못했습니다.`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function stringConstant(source, name) {
  const match = new RegExp(`export const ${name} = "([^"]+)";`).exec(source);
  assert.ok(match, `${name} 상수를 P3 소스에서 찾지 못했습니다.`);
  return match[1];
}

function requireExactKeys(source, description) {
  for (const match of source.matchAll(/requireExactKeys\([^,]+,\s*\[([^\]]*)\],\s*"([^"]+)"\)/g)) {
    if (match[2] === description) {
      return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
    }
  }
  assert.fail(`${description}의 키 목록을 P3 소스에서 찾지 못했습니다.`);
}

test("P3 묶음 상수와 실행기 상수가 같다", async () => {
  const artifacts = await readFile(join(SERVER_SRC, "release", "release_artifacts.ts"), "utf8");
  const materializer = await readFile(join(SERVER_SRC, "runner", "runner_release_materializer.ts"), "utf8");
  const portable = await readFile(join(SERVER_SRC, "release", "portable_release.ts"), "utf8");

  assert.deepEqual(HOST_RELEASE_ARTIFACTS, arrayLiteral(artifacts, "HOST_RELEASE_ARTIFACTS"));
  assert.deepEqual(RUNNER_RELEASE_ARTIFACTS, arrayLiteral(materializer, "RUNNER_RELEASE_ARTIFACTS"));

  assert.equal(PORTABLE_RELEASE_METADATA_FILE, stringConstant(portable, "PORTABLE_RELEASE_METADATA_FILE"));
  assert.equal(PORTABLE_BIND_SCRIPT_FILE, stringConstant(portable, "PORTABLE_BIND_SCRIPT_FILE"));
  assert.equal(PORTABLE_RUNNER_DIRECTORY, stringConstant(portable, "PORTABLE_RUNNER_DIRECTORY"));

  const boundBlock = /const BOUND_RELEASE_EXTRA_FILES: readonly string\[\] = \[([\s\S]*?)\];/.exec(portable);
  assert.ok(boundBlock, "BOUND_RELEASE_EXTRA_FILES를 P3 소스에서 찾지 못했습니다.");
  const boundTokens = [...boundBlock[1].matchAll(/"[^"]+"|[A-Z][A-Z0-9_]+/g)].map((item) => item[0]);
  const constants = {
    PORTABLE_RELEASE_METADATA_FILE,
  };
  const boundFromP3 = boundTokens.map((token) =>
    token.startsWith('"') ? token.slice(1, -1) : constants[token],
  );
  assert.deepEqual(BOUND_RELEASE_EXTRA_FILES, boundFromP3);

  // verifyPortableReleasePayload가 요구하는 목록과 같은 공식으로 만든다.
  const requiredFromP3 = [
    ...arrayLiteral(artifacts, "HOST_RELEASE_ARTIFACTS"),
    ...arrayLiteral(materializer, "RUNNER_RELEASE_ARTIFACTS").map(
      (name) => `${stringConstant(portable, "PORTABLE_RUNNER_DIRECTORY")}/${name}`,
    ),
    stringConstant(portable, "PORTABLE_BIND_SCRIPT_FILE"),
  ];
  assert.deepEqual(PAYLOAD_REQUIRED_FILES, requiredFromP3);

  assert.deepEqual(METADATA_KEYS, requireExactKeys(portable, "portable release metadata v1"));
  assert.deepEqual(FILE_KEYS, requireExactKeys(portable, "portable release file entry"));

  const patternMatch = /const SHA256_PATTERN = (\/[^/\n]+\/);/.exec(portable);
  assert.ok(patternMatch, "SHA256_PATTERN을 P3 소스에서 찾지 못했습니다.");
  assert.equal(String(SHA256_PATTERN), patternMatch[1]);
  assert.match(`sha256-${"a".repeat(64)}`, SHA256_PATTERN);
  assert.doesNotMatch(`sha256-${"A".repeat(64)}`, SHA256_PATTERN);
  assert.doesNotMatch("a".repeat(64), SHA256_PATTERN);
});

test("릴리스 응답의 sha256이 접두사 없는 hex면 RELEASE_MALFORMED로 거부한다", async () => {
  const body = {
    contract_version: 1,
    source_commit: "1".repeat(40),
    sha256: "a".repeat(64),
    size: 1,
    download_path: "/api/node/releases/downloads/bundle-1",
  };
  await assert.rejects(
    fetchCurrentRelease({
      upstream: "http://127.0.0.1:1",
      token: "test-token",
      fetchJsonImpl: async () => ({ status: 200, ok: true, body }),
    }),
    (error) => error.code === "RELEASE_MALFORMED",
  );
});

test("fixture 묶음이 P3 메타데이터 형식과 같다", async (t) => {
  const root = await makeTempRoot("contract-bundle");
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceCommit = "1".repeat(40);
  const bundle = await makeBundle(root, { sourceCommit });
  const raw = await readFile(join(bundle.dir, PORTABLE_RELEASE_METADATA_FILE), "utf8");
  const manifest = JSON.parse(raw);

  assert.deepEqual(Object.keys(manifest), [
    "schema_version",
    "source_commit",
    "schema_generation",
    "wire_generation",
    "files",
  ]);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.source_commit, sourceCommit);
  assert.equal(typeof manifest.schema_generation, "string");
  assert.equal(typeof manifest.wire_generation, "string");
  assert.ok(manifest.schema_generation.length > 0);
  assert.ok(manifest.wire_generation.length > 0);

  const listed = new Set();
  for (const entry of manifest.files) {
    assert.deepEqual(Object.keys(entry), ["path", "sha256", "size"]);
    assert.match(entry.sha256, SHA256_PATTERN);
    assert.ok(Number.isInteger(entry.size) && entry.size >= 0);
    assert.equal(entry.path.includes("\\"), false);
    assert.equal(entry.path.startsWith("/"), false);
    assert.equal(entry.path.split("/").includes(".."), false);
    listed.add(entry.path);
  }
  for (const required of PAYLOAD_REQUIRED_FILES) {
    assert.ok(listed.has(required), `fixture 설명에 ${required}가 없습니다.`);
  }
  // payload 루트의 실제 파일은 설명 + bind가 만드는 파일뿐이어야 한다.
  const actual = [];
  const walk = async (dir, prefix) => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(join(dir, item.name), relativePath);
      else actual.push(relativePath);
    }
  };
  await walk(bundle.dir, "");
  const allowed = new Set([...listed, PORTABLE_RELEASE_METADATA_FILE, ...BOUND_RELEASE_EXTRA_FILES]);
  for (const path of actual) {
    assert.ok(allowed.has(path), `fixture payload에 설명 밖 파일이 있습니다: ${path}`);
  }
  // payload 안에는 launcher가 따로 쓰는 검증 표식이 없다(P3 bind가 미등록 파일로 거부한다).
  assert.equal(listed.has(".portable-verified.json"), false);
  assert.equal(actual.includes(".portable-verified.json"), false);
});

test("러너 소켓 경로 상수와 계산이 P3와 같다", async () => {
  const source = await readFile(join(SERVER_SRC, "runner", "runner_process_paths.ts"), "utf8");
  const linuxMax = Number(/export const LINUX_UNIX_SOCKET_PATH_MAX_BYTES = (\d+);/.exec(source)?.[1]);
  const darwinMax = Number(/export const DARWIN_UNIX_SOCKET_PATH_MAX_BYTES = (\d+);/.exec(source)?.[1]);
  const slugLength = Number(/const RUNNER_SESSION_SLUG_LENGTH = (\d+);/.exec(source)?.[1]);
  const socketName = /const RUNNER_SOCKET_FILE_NAME = "([^"]+)";/.exec(source)?.[1];

  assert.equal(LINUX_UNIX_SOCKET_PATH_MAX_BYTES, linuxMax);
  assert.equal(DARWIN_UNIX_SOCKET_PATH_MAX_BYTES, darwinMax);
  assert.equal(RUNNER_SESSION_SLUG_LENGTH, slugLength);
  assert.equal(RUNNER_SOCKET_FILE_NAME, socketName);

  // P3는 join(stateDirectory, "0".repeat(24), "runner.sock")의 바이트 수를 잰다.
  assert.ok(
    source.includes('"0".repeat(RUNNER_SESSION_SLUG_LENGTH)'),
    "P3의 소켓 경로 조립 방식이 바뀌었습니다.",
  );
  assert.equal(
    runnerSocketPathByteLength("/state/r"),
    Buffer.byteLength(join("/state/r", "0".repeat(slugLength), socketName), "utf8"),
  );
});
