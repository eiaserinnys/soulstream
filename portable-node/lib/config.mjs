import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const STATE_ROOT_PLACEHOLDER = "__STATE_ROOT__";
/** 실행기 기본 설정이 soulstream MCP 주소에 남기는 포트 자리표시자. */
export const SOUL_HOST_PORT_PLACEHOLDER = "__SOUL_HOST_PORT__";

const CONFIG_FILES = [
  { key: "agents", file: "agents.yaml" },
  { key: "mcp_registry", file: "mcp-registry.yaml" },
  { key: "mcp_profiles", file: "mcp-profiles.yaml" },
];

export function platformName(platform = process.platform) {
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  throw new Error(`지원하지 않는 운영체제입니다: ${platform}`);
}

export function archName(arch = process.arch) {
  if (arch === "x64" || arch === "arm64") return arch;
  throw new Error(`지원하지 않는 아키텍처입니다: ${arch}`);
}

/** 런타임 잠금 파일의 플랫폼 키(예: linux-x64, win-x64). */
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platformName(platform) === "win32" ? "win" : platformName(platform)}-${archName(arch)}`;
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
 * soulstream MCP는 127.0.0.1:MCP_INTERNAL_PORT의 내부 리스너가 서비스한다.
 * 템플릿이 남긴 주소의 포트 자리표시자를 이번 실행의 그 포트로 바꾼다.
 */
function substituteSoulHostPort(value, hostPort) {
  if (typeof value === "string") {
    return value.split(SOUL_HOST_PORT_PLACEHOLDER).join(String(hostPort));
  }
  if (Array.isArray(value)) return value.map((item) => substituteSoulHostPort(item, hostPort));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = substituteSoulHostPort(item, hostPort);
    return out;
  }
  return value;
}

/**
 * 실행기 폴더의 템플릿을 이번 실행 값으로 치환해 구성 세대 폴더에 쓴다.
 * 세대 이름은 치환 전 세 템플릿 내용을 이어 붙인 sha256의 앞 12자다.
 * 같은 템플릿은 같은 폴더를 다시 쓰고, 그 폴더를 지난 판의 rollback도 다시 렌더한다.
 */
export async function writeConfigGeneration({ templatesDir, stateRoot, configRoot, hostPort }) {
  const templates = {};
  for (const { key, file } of CONFIG_FILES) {
    templates[key] = await readFile(join(templatesDir, file), "utf8");
  }
  const digest = createHash("sha256")
    .update(CONFIG_FILES.map(({ key }) => templates[key]).join(""))
    .digest("hex");
  const generation = `local-${digest.slice(0, 12)}`;
  const dir = join(configRoot, generation);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const resolve = (value) => substituteSoulHostPort(substituteStateRoot(value, stateRoot), hostPort);
  const files = {};
  for (const { key, file } of CONFIG_FILES) {
    const path = join(dir, file);
    await writeFile(path, resolve(templates[key]), { mode: 0o600 });
    files[key] = path;
  }
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
