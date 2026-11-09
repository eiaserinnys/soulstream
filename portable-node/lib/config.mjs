import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchJson } from "./download.mjs";

export const STATE_ROOT_PLACEHOLDER = "__STATE_ROOT__";

const CONFIG_FILES = [
  { key: "agents", file: "agents.yaml" },
  { key: "model_catalog", file: "model-catalog.yaml" },
  { key: "mcp_registry", file: "mcp-registry.yaml" },
  { key: "mcp_profiles", file: "mcp-profiles.yaml" },
];

const FORBIDDEN_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

export class BootstrapError extends Error {
  constructor(message, code, retryAfterSecs) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
    this.retryAfterSecs = retryAfterSecs;
  }
}

export function platformName(platform = process.platform) {
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  throw new BootstrapError(`지원하지 않는 운영체제입니다: ${platform}`, "UNSUPPORTED_PLATFORM");
}

export function archName(arch = process.arch) {
  if (arch === "x64" || arch === "arm64") return arch;
  throw new BootstrapError(`지원하지 않는 아키텍처입니다: ${arch}`, "UNSUPPORTED_ARCH");
}

/** 런타임 잠금 파일의 플랫폼 키(예: linux-x64, win-x64). */
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platformName(platform) === "win32" ? "win" : platformName(platform)}-${archName(arch)}`;
}

export function sanitizeGeneration(generation) {
  const value = String(generation ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new BootstrapError("구성 세대 이름이 올바르지 않습니다.", "INVALID_GENERATION");
  }
  return value;
}

export function substituteStateRoot(value, stateRoot) {
  if (typeof value === "string") return value.split(STATE_ROOT_PLACEHOLDER).join(stateRoot);
  if (Array.isArray(value)) return value.map((item) => substituteStateRoot(item, stateRoot));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = substituteStateRoot(item, stateRoot);
    return out;
  }
  return value;
}

/**
 * 서버가 주는 구성 조각은 문자열(YAML 원문)일 수도, 객체일 수도 있다.
 * YAML 파일 자리에는 JSON을 그대로 써도 YAML 1.2 파서가 읽는다.
 */
function serializeConfigValue(value) {
  if (typeof value === "string") return value.endsWith("\n") ? value : `${value}\n`;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateBootstrapBody(body) {
  if (!body || typeof body !== "object") {
    throw new BootstrapError("구성 응답이 비었습니다.", "MALFORMED_BOOTSTRAP");
  }
  validateGenerationField(body.config_generation);
  for (const { key } of CONFIG_FILES) {
    if (!(key in body)) throw new BootstrapError(`구성 응답에 ${key}가 없습니다.`, "MALFORMED_BOOTSTRAP");
  }
  if (body.env !== undefined && (body.env === null || typeof body.env !== "object" || Array.isArray(body.env))) {
    throw new BootstrapError("구성 응답의 env 형태가 올바르지 않습니다.", "MALFORMED_BOOTSTRAP");
  }
}

function validateGenerationField(generation) {
  if (generation === undefined || generation === null || generation === "") return;
  sanitizeGeneration(generation);
}

export function filterEnv(env) {
  const out = {};
  const rejected = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      rejected.push(key);
      continue;
    }
    if (FORBIDDEN_ENV_KEYS.has(key)) {
      rejected.push(key);
      continue;
    }
    out[key] = value === null || value === undefined ? "" : String(value);
  }
  return { env: out, rejected };
}

export async function fetchBootstrap({
  upstream,
  token,
  sourceCommit,
  platform = process.platform,
  arch = process.arch,
  timeoutMs = 15000,
  fetchJsonImpl = fetchJson,
}) {
  const url = new URL("/api/node/bootstrap", upstream).toString();
  const response = await fetchJsonImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ source_commit: sourceCommit, platform: platformName(platform), arch: archName(arch) }),
    timeoutMs,
  });
  if (response.status === 401) {
    throw new BootstrapError("노드 자격 증명이 더 이상 유효하지 않습니다.", "REVOKED");
  }
  if (response.status === 409) {
    const code = String(response.body?.code ?? response.body?.error ?? "");
    if (code.includes("TRUST_CLASSIFICATION_PENDING")) {
      throw new BootstrapError(
        "이 노드는 아직 신뢰 등급 분류가 끝나지 않았습니다. 관리자가 분류하면 자동으로 이어집니다.",
        "TRUST_CLASSIFICATION_PENDING",
        30,
      );
    }
    if (/version|mismatch/i.test(code)) {
      throw new BootstrapError("앱 판과 구성이 맞지 않습니다. 판을 맞춘 뒤 다시 시도합니다.", "VERSION_MISMATCH");
    }
    throw new BootstrapError(`구성 요청이 거절되었습니다 (${code || 409}).`, "CONFLICT");
  }
  if (!response.ok) {
    throw new BootstrapError(`구성 요청이 실패했습니다 (${response.status}).`, "FETCH_FAILED");
  }
  validateBootstrapBody(response.body);
  return response.body;
}

export async function writeConfigGeneration({ bootstrap, stateRoot, configRoot }) {
  const generation = sanitizeGeneration(bootstrap.config_generation);
  const dir = join(configRoot, generation);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const files = {};
  for (const { key, file } of CONFIG_FILES) {
    const path = join(dir, file);
    await writeFile(path, serializeConfigValue(substituteStateRoot(bootstrap[key], stateRoot)), {
      mode: 0o600,
    });
    files[key] = path;
  }

  const envPath = join(dir, "env.json");
  const rawEnv = substituteStateRoot(bootstrap.env ?? {}, stateRoot);
  await writeFile(envPath, `${JSON.stringify(rawEnv, null, 2)}\n`, { mode: 0o600 });
  files.env = envPath;

  const metaPath = join(dir, "bootstrap.json");
  await writeFile(
    metaPath,
    `${JSON.stringify(
      {
        config_generation: generation,
        source_commit: bootstrap.source_commit ?? null,
        platform: platformName(),
        arch: archName(),
        applied_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  return { dir, files, generation };
}

/**
 * dotenv 형식(.env.soul-server-ts)으로 고정 순서로 쓴다.
 * 값에 공백·특수문자가 있으면 큰따옴표로 감싸고 개행은 \n으로 적는다.
 */
export function formatEnvFile(env) {
  const lines = [];
  for (const key of Object.keys(env).sort()) {
    let value = String(env[key] ?? "");
    if (value === "" || /[\s"'\\#]/.test(value)) {
      value = `"${value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')}"`;
    }
    lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function readConfigGeneration(dir) {
  const envRaw = await readFile(join(dir, "env.json"), "utf8");
  return { env: JSON.parse(envRaw) };
}
