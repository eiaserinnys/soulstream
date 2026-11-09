import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  makeScenario,
  readJsonFile,
  startLauncher,
  startShim,
  waitFor,
  waitForStarted,
} from "./helpers.mjs";

const childMarker = (stateDir) => join(stateDir, "home", "child-ran.txt");

async function startFirstRelease(scenario) {
  await scenario.publish(scenario.source.firstCommit);
  const handle = startLauncher({ portableDir: scenario.source.portableDir, env: scenario.env() });
  await waitForStarted(handle, scenario.stateDir);
  return handle;
}

test("전환 준비의 bind가 실패하면 현재 child를 멈추지 않고 계속 실행한다", async (t) => {
  const scenario = await makeScenario("rollback-stage", { checkIntervalSecs: 1 });
  t.after(scenario.close);
  const { source, stateDir, publish } = scenario;
  const first = await startFirstRelease(scenario);
  try {
    const markerBefore = await readFile(childMarker(stateDir), "utf8");
    const secondCommit = await source.commitFile("release-b.txt", "b\n", "B");
    await publish(secondCommit, { bindFailAfter: 1 });

    await waitFor(() => first.output.includes("경고: 새 판으로 전환하지 못했습니다"), { timeoutMs: 120000 });
    assert.equal(first.output.includes("child를 정상 종료하고"), false);
    // child는 계속 살아 있고 같은 판을 실행한다.
    assert.equal(await readFile(childMarker(stateDir), "utf8"), markerBefore);
    assert.equal((await readJsonFile(join(stateDir, "active-release.json"))).source_commit, source.firstCommit);
    assert.equal(existsSync(join(stateDir, "rollback.json")), false);
    assert.equal(existsSync(join(stateDir, "reentry.json")), false, "재진입 기록이 남았습니다.");
  } finally {
    first.stop();
    await first.exit;
  }
});

test("재진입 뒤 bind가 실패하면 마지막으로 검증된 판으로 되돌린다", async (t) => {
  const scenario = await makeScenario("rollback-bind", { checkIntervalSecs: 1 });
  t.after(scenario.close);
  const { source, stateDir, publish } = scenario;
  await publish(source.firstCommit);
  const shim = startShim({ portableDir: source.portableDir, env: scenario.env() });
  try {
    await waitForStarted(shim, stateDir);
    const markerBefore = await readFile(childMarker(stateDir), "utf8");
    const secondCommit = await source.commitFile("release-b.txt", "b\n", "B");
    // 첫 bind는 전환 준비에서 성공하고, 재진입 뒤 두 번째 bind가 실패한다.
    await publish(secondCommit, { bindFailAfter: 2 });

    await waitFor(() => existsSync(join(stateDir, "rollback.json")), { timeoutMs: 180000 });
    const rollback = await readJsonFile(join(stateDir, "rollback.json"));
    assert.equal(rollback.from, secondCommit);
    assert.equal(rollback.to, source.firstCommit);
    assert.match(shim.output, /새 판 준비·기동에 실패했습니다/);
    // rollback.json은 기동 성공 뒤에 쓰이고, "이전 판" 로그는 그 다음 줄이라 조금 기다린다.
    await waitFor(() => shim.output.includes("이전 판"), { timeoutMs: 60000 });

    await waitFor(async () => (await readFile(childMarker(stateDir), "utf8")) !== markerBefore, {
      timeoutMs: 60000,
    });
    const active = await readJsonFile(join(stateDir, "active-release.json"));
    assert.equal(active.source_commit, source.firstCommit);
  } finally {
    shim.stop();
    await shim.exit;
  }
});

test("새 판이 기동에 실패하면 마지막으로 검증된 판으로 되돌린다", async (t) => {
  const scenario = await makeScenario("rollback-start", { checkIntervalSecs: 1 });
  t.after(scenario.close);
  const { source, stateDir, publish } = scenario;
  await publish(source.firstCommit);
  const shim = startShim({ portableDir: source.portableDir, env: scenario.env() });
  try {
    await waitForStarted(shim, stateDir);
    const markerBefore = await readFile(childMarker(stateDir), "utf8");
    const secondCommit = await source.commitFile("release-b.txt", "b\n", "B");
    await publish(secondCommit, { crashOnStart: true });

    await waitFor(() => existsSync(join(stateDir, "rollback.json")), { timeoutMs: 180000 });
    const rollback = await readJsonFile(join(stateDir, "rollback.json"));
    assert.equal(rollback.from, secondCommit);
    assert.equal(rollback.to, source.firstCommit);
    assert.match(shim.output, /이전 판/);

    await waitFor(async () => (await readFile(childMarker(stateDir), "utf8")) !== markerBefore, {
      timeoutMs: 60000,
    });
    assert.equal((await readJsonFile(join(stateDir, "active-release.json"))).source_commit, source.firstCommit);
  } finally {
    shim.stop();
    await shim.exit;
  }
});
