// 실행기 기본 설정: 실행기 폴더의 템플릿을 자리표시자 치환해 세대 폴더에 쓴다.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  SOUL_HOST_PORT_PLACEHOLDER,
  STATE_ROOT_PLACEHOLDER,
  writeConfigGeneration,
} from "../lib/config.mjs";
import { buildChildEnv } from "../lib/environment.mjs";
import { PORTABLE_SOURCE, makeTempRoot, sha256 } from "./helpers.mjs";

const TEMPLATES_DIR = join(PORTABLE_SOURCE, "config");
const TEMPLATE_FILES = [
  { key: "agents", file: "agents.yaml" },
  { key: "model_catalog", file: "model-catalog.yaml" },
  { key: "mcp_registry", file: "mcp-registry.yaml" },
  { key: "mcp_profiles", file: "mcp-profiles.yaml" },
];

async function templateDigest() {
  const parts = [];
  for (const { file } of TEMPLATE_FILES) parts.push(await readFile(join(TEMPLATES_DIR, file), "utf8"));
  return sha256(parts.join("")).slice(0, 12);
}

function fakeRuntimes(root) {
  const executable = join(root, "bin", "node");
  return {
    node: { executable },
    python: { executable },
    claude: { executable },
    codex: { executable },
  };
}

test("템플릿을 치환해 sha256 기반 세대 폴더에 쓰고 env.json은 남기지 않는다", async (t) => {
  const root = await makeTempRoot("config-generation");
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const configRoot = join(stateRoot, "config");

  const rendered = await writeConfigGeneration({
    templatesDir: TEMPLATES_DIR,
    stateRoot,
    configRoot,
    hostPort: 41117,
  });
  const expectedGeneration = `local-${await templateDigest()}`;
  assert.equal(rendered.generation, expectedGeneration);
  assert.equal(rendered.dir, join(configRoot, expectedGeneration));

  for (const { key, file } of TEMPLATE_FILES) {
    const text = await readFile(join(rendered.dir, file), "utf8");
    assert.equal(text.includes(STATE_ROOT_PLACEHOLDER), false, `${file}에 상태 루트 자리표시자가 남으면 안 됩니다.`);
    assert.equal(text.includes(SOUL_HOST_PORT_PLACEHOLDER), false, `${file}에 MCP 포트 자리표시자가 남으면 안 됩니다.`);
    assert.equal(rendered.files[key], join(rendered.dir, file));
  }
  const agents = await readFile(join(rendered.dir, "agents.yaml"), "utf8");
  assert.ok(agents.includes(`workspace_dir: ${join(stateRoot, "workspace")}`));
  const registry = await readFile(join(rendered.dir, "mcp-registry.yaml"), "utf8");
  assert.ok(registry.includes("url: http://127.0.0.1:41117/mcp"));
  assert.equal(existsSync(join(rendered.dir, "env.json")), false);
  assert.equal(existsSync(join(rendered.dir, "bootstrap.json")), false);

  const rerendered = await writeConfigGeneration({
    templatesDir: TEMPLATES_DIR,
    stateRoot,
    configRoot,
    hostPort: 42229,
  });
  assert.equal(rerendered.generation, rendered.generation, "템플릿 내용이 같으면 같은 세대 폴더를 다시 씁니다.");
  const updated = await readFile(join(rerendered.dir, "mcp-registry.yaml"), "utf8");
  assert.equal(updated.includes(":41117/"), false, "같은 세대 폴더에 낡은 포트가 남으면 안 됩니다.");
  assert.ok(updated.includes("url: http://127.0.0.1:42229/mcp"));
});

test("child 환경에는 bootstrap이 주던 값과 ATOM_ENABLED가 없고 노드 토큰 헤더 값이 있다", async (t) => {
  const root = await makeTempRoot("config-child-env");
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const configDir = join(stateRoot, "config", "local-000000000000");
  const env = buildChildEnv({
    stateRoot,
    defaults: { node_ws_url: "ws://upstream.invalid/ws/node" },
    node: { node_id: "portable-test-node", token: "test-node-token-7f3a" },
    configDir,
    releaseDir: join(stateRoot, "releases", "commit"),
    runtimes: fakeRuntimes(root),
    ports: { host: 41000, mcp: 41117 },
    extraEnv: { ATOM_API_KEY: "atom-secret-value", EXTRA_FROM_BOOTSTRAP: "yes" },
  });
  assert.equal("ATOM_ENABLED" in env, false);
  assert.equal("ATOM_API_KEY" in env, false);
  assert.equal("EXTRA_FROM_BOOTSTRAP" in env, false);
  assert.equal(env.PORTABLE_LOCAL_MCP_AUTHORIZATION, "Bearer test-node-token-7f3a");
  assert.equal(env.AGENTS_CONFIG_PATH, join(configDir, "agents.yaml"));
  assert.equal(env.MCP_INTERNAL_PORT, "41117");
});
