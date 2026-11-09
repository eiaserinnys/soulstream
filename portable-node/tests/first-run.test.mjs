import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  TOKEN,
  git,
  makeScenario,
  pathExists,
  readJsonFile,
  startLauncher,
  waitForStarted,
} from "./helpers.mjs";

test("첫 실행: 참여→판 맞춤→구성→묶음→두 리포→감독 기동", async (t) => {
  const scenario = await makeScenario("first-run");
  t.after(scenario.close);
  const { source, stateDir, publish, env } = scenario;
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

    const configDir = join(stateDir, "config", `gen-${source.firstCommit.slice(0, 8)}`);
    for (const file of ["agents.yaml", "model-catalog.yaml", "mcp-registry.yaml", "mcp-profiles.yaml", "env.json"]) {
      assert.ok(existsSync(join(configDir, file)), file);
    }

    const releaseDir = join(stateDir, "releases", source.firstCommit);
    assert.ok(existsSync(join(releaseDir, "portable-release.json")));
    assert.ok(existsSync(join(releaseDir, "release-manifest.json")));
    const envFile = await readFile(join(releaseDir, ".env.soul-server-ts"), "utf8");
    assert.match(envFile, new RegExp(`AUTH_BEARER_TOKEN=${TOKEN}`));

    const workspace = join(stateDir, "workspace");
    assert.ok(existsSync(join(workspace, "notes", "today.md")));
    assert.equal(existsSync(join(workspace, ".local", "artifacts")), false);
    const filter = await git(workspace, ["config", "--get", "remote.origin.partialclonefilter"]);
    assert.equal(filter.stdout.trim(), "blob:none");
    assert.ok(existsSync(join(stateDir, "common", "skills", "readme.md")));

    const childEnv = await readJsonFile(join(stateDir, "home", "child-env.json"));
    assert.equal(childEnv.AUTH_BEARER_TOKEN, TOKEN);
    assert.equal(childEnv.SOULSTREAM_NODE_ID, "portable-test-node");
    assert.equal(childEnv.HOME, join(stateDir, "home"));
    assert.equal(childEnv.USERPROFILE, join(stateDir, "home"));
    assert.equal(childEnv.CODEX_HOME, join(stateDir, "codex"));
    assert.equal(childEnv.AGENT_COMMON_FILES_DIR, join(stateDir, "common"));
    assert.equal(childEnv.GIT_CONFIG_GLOBAL, join(stateDir, "git", "gitconfig"));
    assert.equal(childEnv.AGENT_COMMON_FILES_DIR, join(stateDir, "common"));
    assert.equal(childEnv.PATH.split(delimiter)[0], join(stateDir, "bin"));
    assert.equal(childEnv.ATOM_API_KEY, "atom-secret-value");
    assert.equal(childEnv.EXTRA_FROM_BOOTSTRAP, "yes");
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
