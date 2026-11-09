import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TOKEN, makeScenario, startLauncher } from "./helpers.mjs";

async function seedNode(stateDir, upstream) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "node.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        node_id: "portable-test-node",
        company_pc: false,
        token: TOKEN,
        upstream,
        node_ws_url: `${upstream.replace(/^http/, "ws")}/ws/node`,
        ports: {},
      },
      null,
      2,
    )}\n`,
  );
}

test("참여 코드가 만료되면 알리고 끝낸다(자동 재참여 없음)", async (t) => {
  const scenario = await makeScenario("pairing-expiry");
  t.after(scenario.close);
  const { source, stateDir, orch, env } = scenario;
  orch.state.pairingExpiresAt = new Date(Date.now() - 1000).toISOString();
  const handle = startLauncher({ portableDir: source.portableDir, env: env() });
  const result = await handle.exit;
  assert.notEqual(result.code, 0);
  assert.match(handle.output, /유효 시간이 지났습니다/);
  assert.equal(existsSync(join(stateDir, "node.json")), false);
  assert.equal(orch.state.pairingCount, 1);
  assert.equal(orch.state.pollCount, 0);
});

test("자격 증명이 취소되면(401) 중단하고 다시 참여하지 않는다", async (t) => {
  const scenario = await makeScenario("revoked");
  t.after(scenario.close);
  const { source, stateDir, orch, env } = scenario;
  await seedNode(stateDir, orch.url);
  orch.state.revoked = true;
  const handle = startLauncher({ portableDir: source.portableDir, env: env() });
  const result = await handle.exit;
  assert.notEqual(result.code, 0);
  assert.match(handle.output, /자격 증명이 취소되었습니다/);
  assert.equal(orch.state.pairingCount, 0);
});

test("링크가 든 가짜 앱 묶음은 풀지 않고 거부한다", async (t) => {
  const scenario = await makeScenario("bundle-link");
  t.after(scenario.close);
  const { source, stateDir, orch, publish, env } = scenario;
  await seedNode(stateDir, orch.url);
  try {
    await publish(source.firstCommit, { unsafeLink: { path: "escape", target: "../../outside" } });
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip("윈도우에서 심볼릭 링크를 만들 권한이 없습니다.");
      return;
    }
    throw error;
  }
  const handle = startLauncher({ portableDir: source.portableDir, env: env() });
  const result = await handle.exit;
  assert.notEqual(result.code, 0);
  assert.match(handle.output, /앱 묶음에 허용하지 않는 링크 항목이 있습니다/);
  assert.equal(existsSync(join(stateDir, "home", "child-ran.txt")), false);
  assert.equal(existsSync(join(stateDir, "releases", source.firstCommit)), false);
});

test("앱 묶음 파일 해시가 다르면 기동하지 않고 중단한다", async (t) => {
  const scenario = await makeScenario("payload-mismatch");
  t.after(scenario.close);
  const { source, stateDir, orch, publish, env } = scenario;
  await seedNode(stateDir, orch.url);
  await publish(source.firstCommit, { tamper: true });
  const handle = startLauncher({ portableDir: source.portableDir, env: env() });
  const result = await handle.exit;
  assert.notEqual(result.code, 0);
  assert.match(handle.output, /앱 묶음 파일 해시가 다릅니다: main\.js/);
  assert.equal(existsSync(join(stateDir, "home", "child-ran.txt")), false);
  assert.equal(existsSync(join(stateDir, "releases", source.firstCommit)), false);
});
