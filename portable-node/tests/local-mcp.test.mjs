// P7b: 실행기 기본 설정의 soulstream MCP 자리표시자를 실행기가 채운다.
// 템플릿은 url에 __SOUL_HOST_PORT__를, Authorization 헤더에 env 참조를 남긴다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  TOKEN,
  configGenerations,
  makeScenario,
  readJsonFile,
  startLauncher,
  waitFor,
  waitForStarted,
} from "./helpers.mjs";

async function readConfigDir(stateDir) {
  const generations = await configGenerations(stateDir);
  assert.equal(generations.length, 1, "구성 세대 폴더는 하나입니다.");
  return generations[0];
}

async function readRegistry(configDir) {
  const text = await readFile(join(configDir, "mcp-registry.yaml"), "utf8");
  const urlMatch = /^[ \t]+url:[ \t]*(\S+)$/m.exec(text);
  assert.ok(urlMatch, "mcp-registry.yaml에 url이 있어야 합니다.");
  return {
    text,
    serverCount: (text.match(/^[ \t]*- id:/gm) ?? []).length,
    id: /^[ \t]*- id:[ \t]*(\S+)$/m.exec(text)?.[1],
    type: /^[ \t]+type:[ \t]*(\S+)$/m.exec(text)?.[1],
    url: urlMatch[1],
    headerRef: /Authorization:[ \t]*\r?\n[ \t]*env:[ \t]*(\S+)/.exec(text)?.[1],
  };
}

test("soulstream MCP 구성에 실제 내부 포트와 노드 토큰 헤더 값을 넣는다", async (t) => {
  const scenario = await makeScenario("local-mcp");
  t.after(scenario.close);
  const { source, stateDir, publish, env } = scenario;
  await publish(source.firstCommit);
  const handle = startLauncher({ portableDir: source.portableDir, env: env() });
  try {
    try {
      await waitForStarted(handle, stateDir, { timeoutMs: 90000 });
    } catch (error) {
      throw new Error(`${error.message}\n--- launcher output ---\n${handle.output}`);
    }
    const node = await readJsonFile(join(stateDir, "node.json"));
    const configDir = await readConfigDir(stateDir);

    const registry = await readRegistry(configDir);
    assert.equal(registry.serverCount, 1, "실행기 기본 설정에는 soulstream MCP 하나만 있습니다.");
    assert.equal(registry.id, "soulstream");
    assert.equal(registry.type, "streamable_http");
    assert.equal(
      registry.url,
      `http://127.0.0.1:${node.ports.mcp}/mcp`,
      "MCP는 127.0.0.1:MCP_INTERNAL_PORT가 서비스하는 내부 리스너에 붙어야 합니다.",
    );
    assert.equal(registry.headerRef, "PORTABLE_LOCAL_MCP_AUTHORIZATION");
    assert.equal(
      registry.text.includes("__SOUL_HOST_PORT__"),
      false,
      "자리표시자가 구성 파일에 남으면 안 됩니다.",
    );

    const expected = `Bearer ${TOKEN}`;
    const childEnv = await readJsonFile(join(stateDir, "home", "child-env.json"));
    assert.equal(childEnv.PORTABLE_LOCAL_MCP_AUTHORIZATION, expected);
    assert.equal(childEnv.AUTH_BEARER_TOKEN, TOKEN);

    const envFile = await readFile(join(stateDir, "releases", source.firstCommit, ".env.soul-server-ts"), "utf8");
    const line = envFile
      .split("\n")
      .find((entry) => entry.startsWith("PORTABLE_LOCAL_MCP_AUTHORIZATION="));
    assert.equal(line, `PORTABLE_LOCAL_MCP_AUTHORIZATION="${expected}"`);

    assert.equal(handle.output.includes(TOKEN), false, "노드 토큰이 로그에 찍히면 안 됩니다.");
  } finally {
    handle.stop();
    await handle.exit;
  }
});

test("포트가 바뀐 재시작은 같은 구성 세대의 MCP 주소를 새 포트로 다시 쓴다", async (t) => {
  const scenario = await makeScenario("local-mcp-restart");
  t.after(scenario.close);
  const { source, stateDir, publish, env } = scenario;
  await publish(source.firstCommit);

  const first = startLauncher({ portableDir: source.portableDir, env: env() });
  let node;
  let configDir;
  try {
    await waitForStarted(first, stateDir, { timeoutMs: 90000 });
    node = await readJsonFile(join(stateDir, "node.json"));
    configDir = await readConfigDir(stateDir);
  } finally {
    first.stop();
    await first.exit;
  }
  assert.equal((await readRegistry(configDir)).url, `http://127.0.0.1:${node.ports.mcp}/mcp`);

  // 저장된 MCP 포트를 점유해 실행기가 새 포트를 잡게 만든다.
  const blocker = createServer();
  await new Promise((done, fail) => {
    blocker.once("error", fail);
    blocker.listen(node.ports.mcp, "127.0.0.1", done);
  });
  t.after(() => new Promise((done) => blocker.close(done)));

  const second = startLauncher({ portableDir: source.portableDir, env: env() });
  try {
    await waitForStarted(second, stateDir, { timeoutMs: 90000 });
    await waitFor(
      async () => {
        try {
          return (await readJsonFile(join(stateDir, "node.json"))).ports.mcp !== node.ports.mcp;
        } catch {
          return false;
        }
      },
      { timeoutMs: 60000 },
    );
    const updated = await readJsonFile(join(stateDir, "node.json"));
    assert.notEqual(updated.ports.mcp, node.ports.mcp, "점유된 포트 대신 새 포트를 잡아야 합니다.");

    assert.equal(
      (await readRegistry(configDir)).url,
      `http://127.0.0.1:${updated.ports.mcp}/mcp`,
      "같은 세대 폴더에 낡은 포트가 남으면 안 됩니다.",
    );
    await waitFor(
      async () => {
        try {
          return (await readJsonFile(join(stateDir, "home", "child-env.json"))).MCP_INTERNAL_PORT
            === String(updated.ports.mcp);
        } catch {
          return false;
        }
      },
      { timeoutMs: 60000 },
    );
    const childEnv = await readJsonFile(join(stateDir, "home", "child-env.json"));
    assert.equal(childEnv.MCP_INTERNAL_PORT, String(updated.ports.mcp));
    assert.equal(childEnv.PORTABLE_LOCAL_MCP_AUTHORIZATION, `Bearer ${TOKEN}`);
  } finally {
    second.stop();
    await second.exit;
  }
});
