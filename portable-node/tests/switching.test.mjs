import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, makeScenario, readJsonFile, startShim, waitFor, waitForStarted } from "./helpers.mjs";

const childMarker = (stateDir) => join(stateDir, "home", "child-ran.txt");

test("새 판은 current 커밋으로만 맞추고 로컬 상태를 보존한다", async (t) => {
  const scenario = await makeScenario("switch", { checkIntervalSecs: 1 });
  t.after(scenario.close);
  const { source, stateDir, publish, env } = scenario;
  await publish(source.firstCommit);
  const shim = startShim({ portableDir: source.portableDir, env: env() });
  try {
    await waitForStarted(shim, stateDir);
    const firstMarker = await readFile(childMarker(stateDir), "utf8");
    await writeFile(join(stateDir, "workspace", "local-notes.txt"), "preserve me\n");

    const commitB = await source.commitFile("notes-b.txt", "B\n", "B");
    const commitC = await source.commitFile("notes-c.txt", "C\n", "C");
    await publish(commitB);

    await waitFor(
      async () => {
        try {
          return (await readJsonFile(join(stateDir, "active-release.json"))).source_commit === commitB;
        } catch {
          return false;
        }
      },
      { timeoutMs: 120000 },
    );
    await waitFor(
      () => (shim.output.match(/soul-server를 시작했습니다/g) ?? []).length >= 2,
      { timeoutMs: 60000 },
    );
    await waitFor(async () => (await readFile(childMarker(stateDir), "utf8")) !== firstMarker, {
      timeoutMs: 60000,
    });

    const head = (await git(source.repo, ["rev-parse", "HEAD"])).stdout.trim();
    assert.equal(head, commitB, "current가 가리키는 커밋에 맞춰야 합니다.");
    assert.notEqual(head, commitC, "origin/main 끝을 따라가면 안 됩니다.");
    assert.ok(existsSync(join(stateDir, "workspace", "local-notes.txt")), "상태 폴더가 보존되어야 합니다.");
    assert.ok(existsSync(join(stateDir, "config", `gen-${commitB.slice(0, 8)}`)));
    assert.ok(existsSync(join(stateDir, "releases", commitB)));
    const active = await readJsonFile(join(stateDir, "active-release.json"));
    assert.equal(active.source_commit, commitB);
  } finally {
    shim.stop();
    await shim.exit;
  }
});

test("소스 작업 트리에 변경이 있으면 판 전환을 보류한다", async (t) => {
  const scenario = await makeScenario("switch-dirty", { checkIntervalSecs: 1 });
  t.after(scenario.close);
  const { source, stateDir, publish, env } = scenario;
  await publish(source.firstCommit);
  const shim = startShim({ portableDir: source.portableDir, env: env() });
  try {
    await waitForStarted(shim, stateDir);
    const firstMarker = await readFile(childMarker(stateDir), "utf8");

    await writeFile(join(source.repo, "README.md"), "dirty local change\n");
    const commitB = await source.commitFile("notes-b.txt", "B\n", "B");
    await publish(commitB);

    await waitFor(() => shim.output.includes("판 전환을 보류합니다"), { timeoutMs: 60000 });
    const active = await readJsonFile(join(stateDir, "active-release.json"));
    assert.equal(active.source_commit, source.firstCommit);
    assert.equal(await readFile(join(source.repo, "README.md"), "utf8"), "dirty local change\n");
    assert.equal(shim.child.exitCode, null, "child는 계속 살아 있어야 합니다.");
    await new Promise((done) => setTimeout(done, 2500));
    assert.equal(await readFile(childMarker(stateDir), "utf8"), firstMarker, "child가 다시 뜨면 안 됩니다.");
  } finally {
    shim.stop();
    await shim.exit;
  }
});
