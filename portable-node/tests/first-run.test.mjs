import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import {
  TOKEN,
  configGenerations,
  makeScenario,
  pathExists,
  readJsonFile,
  startLauncher,
  waitForStarted,
} from "./helpers.mjs";

test("첫 실행: 참여→판 맞춤→구성→묶음→빈 작업 폴더→감독 기동", async (t) => {
  const scenario = await makeScenario("first-run");
  t.after(scenario.close);
  const { source, stateDir, orch, publish, env } = scenario;
  await publish(source.firstCommit);
  const handle = startLauncher({
    portableDir: source.portableDir,
    env: env({ GH_TOKEN: "parent-forbidden", GITHUB_TOKEN: "parent-forbidden" }),
  });
  let earlyExit = null;
  handle.exit.then((result) => {
    earlyExit = result;
  });
  try {
    try {
      await waitForStarted(handle, stateDir, { timeoutMs: 90000 });
    } catch (error) {
      throw new Error(`${error.message}\n--- launcher output ---\n${handle.output}\n--- exit: ${JSON.stringify(earlyExit)}`);
    }
    const output = handle.output;
    assert.match(output, /이 코드를 알려 승인을 요청하세요\./);
    assert.match(output, /ABCD-EFGH/);
    assert.match(output, /참여가 승인되었습니다/);
    assert.match(output, /soul-server를 시작했습니다/);
    assert.equal(output.includes("회사 PC"), false, "첫 실행은 노드 이름만 묻습니다.");
    assert.equal(orch.state.lastPairStart.company_pc, false, "참여 API에는 boolean false를 보냅니다.");
    assert.equal(
      orch.state.requestPaths.includes("/api/node/bootstrap"),
      false,
      "실행기는 구성 내려주기를 부르지 않습니다.",
    );

    const nodePath = join(stateDir, "node.json");
    const node = await readJsonFile(nodePath);
    assert.equal(node.token, TOKEN);
    assert.equal(node.node_id, "portable-test-node");
    assert.equal(node.company_pc, false);
    assert.ok(node.ports.host > 0);
    assert.ok(node.ports.mcp > 0);
    assert.notEqual(node.ports.host, node.ports.mcp);
    if (process.platform !== "win32") {
      assert.equal((await stat(nodePath)).mode & 0o777, 0o600);
    }

    const generations = await configGenerations(stateDir);
    assert.equal(generations.length, 1, "구성 세대 폴더는 하나입니다.");
    const configDir = generations[0];
    for (const file of ["agents.yaml", "mcp-registry.yaml", "mcp-profiles.yaml"]) {
      assert.ok(existsSync(join(configDir, file)), file);
    }
    assert.equal(existsSync(join(configDir, "model-catalog.yaml")), false, "카탈로그는 구성 템플릿이 아닙니다.");
    assert.equal(existsSync(join(configDir, "env.json")), false);

    const releaseDir = join(stateDir, "releases", source.firstCommit);
    assert.ok(existsSync(join(releaseDir, "portable-release.json")));
    assert.ok(existsSync(join(releaseDir, "main.js")), "P3 묶음은 main.js를 루트에 둡니다.");
    assert.ok(existsSync(join(releaseDir, "runner", "runner_entry.js")));
    assert.ok(existsSync(join(releaseDir, "release-manifest.json")));
    assert.ok(
      existsSync(join(stateDir, "releases", `${source.firstCommit}.verified.json`)),
      "검증 기록은 payload 밖에 있어야 합니다.",
    );
    assert.equal(existsSync(join(releaseDir, ".portable-verified.json")), false);
    const envFile = await readFile(join(releaseDir, ".env.soul-server-ts"), "utf8");
    assert.match(envFile, new RegExp(`AUTH_BEARER_TOKEN=${TOKEN}`));
    assert.equal(envFile.includes("MODEL_CATALOG_PATH"), false, "카탈로그 경로는 env가 아니라 bind 인자입니다.");

    const bindArgs = await readJsonFile(join(releaseDir, "bind-args.json"));
    const bindValue = (name) => bindArgs[bindArgs.indexOf(name) + 1];
    assert.equal(
      bindValue("--catalog-path"),
      resolve(source.repo, "packages", "model-catalog", "data", "model-catalog.yaml"),
      "bind는 clone 정본 카탈로그 경로를 받습니다.",
    );

    const workspace = join(stateDir, "workspace");
    assert.ok(existsSync(workspace), "작업 폴더는 첫 실행에서 만듭니다.");
    assert.deepEqual(await readdir(workspace), [".projects"], "작업 폴더에는 .projects만 있어야 합니다.");
    assert.deepEqual(
      await readdir(join(workspace, ".projects")),
      [],
      "작업 폴더는 비어 있어야 합니다.",
    );
    if (process.platform !== "win32") {
      assert.equal(
        (await stat(join(workspace, ".projects"))).mode & 0o777,
        0o700,
        "작업 폴더는 0o700으로 만듭니다.",
      );
    }

    const childEnv = await readJsonFile(join(stateDir, "home", "child-env.json"));
    assert.equal(childEnv.AUTH_BEARER_TOKEN, TOKEN);
    assert.equal(childEnv.SOULSTREAM_NODE_ID, "portable-test-node");
    assert.equal(childEnv.HOME, join(stateDir, "home"));
    assert.equal(childEnv.USERPROFILE, join(stateDir, "home"));
    assert.equal(childEnv.CODEX_HOME, join(stateDir, "codex"));
    assert.equal(childEnv.SOUL_RUNNER_ARTIFACT_DIR, join(releaseDir, "runner"));
    assert.equal("AGENT_COMMON_FILES_DIR" in childEnv, false, "공통 폴더를 child env에 넣지 않습니다.");
    assert.equal(childEnv.GIT_CONFIG_GLOBAL, join(stateDir, "git", "gitconfig"));
    assert.equal(childEnv.PATH.split(delimiter)[0], join(stateDir, "bin"));
    assert.equal("ATOM_ENABLED" in childEnv, false);
    assert.equal("ATOM_API_KEY" in childEnv, false);
    assert.equal("MODEL_CATALOG_PATH" in childEnv, false, "카탈로그 경로를 child env로 주지 않습니다.");
    assert.equal("MODEL_CATALOG_GROUPS" in childEnv, false, "추가 묶음은 기본값이 빈 값입니다.");
    assert.equal("EXTRA_FROM_BOOTSTRAP" in childEnv, false);
    assert.equal(childEnv.PORTABLE_LOCAL_MCP_AUTHORIZATION, `Bearer ${TOKEN}`);
    assert.equal(childEnv.SESSION_ISOLATION_MODE, "off");
    assert.equal(childEnv.DISABLE_AUTOUPDATER, "1");
    assert.equal(childEnv.CODEX_ADAPTER_MODE, "app-server");
    assert.equal(childEnv.PORT, String(node.ports.host));
    assert.equal(childEnv.MCP_INTERNAL_PORT, String(node.ports.mcp));
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
      assert.equal(key in childEnv, false, `${key}가 child env에 있습니다.`);
    }

    const active = await readJsonFile(join(stateDir, "active-release.json"));
    assert.equal(active.source_commit, source.firstCommit);
    assert.ok(await pathExists(join(stateDir, "codex", "config.toml")));
    const codexConfig = await readFile(join(stateDir, "codex", "config.toml"), "utf8");
    assert.match(codexConfig, /cli_auth_credentials_store = "file"/);
  } finally {
    handle.stop();
    await handle.exit;
  }
});
