import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, makeScenario, startLauncher, waitFor, waitForStarted } from "./helpers.mjs";

const childMarker = (stateDir) => join(stateDir, "home", "child-ran.txt");

test("ff-only 동기화가 실패해도 로컬 변경을 보존하고 기동한다", async (t) => {
  const scenario = await makeScenario("sync");
  t.after(scenario.close);
  const { source, stateDir, repos, publish, env } = scenario;
  await publish(source.firstCommit);

  const first = startLauncher({ portableDir: source.portableDir, env: env() });
  try {
    await waitForStarted(first, stateDir);
  } finally {
    first.stop();
    await first.exit;
  }
  const markerAfterFirst = await readFile(childMarker(stateDir), "utf8");

  await writeFile(join(repos.workspace.work, "notes", "today.md"), "remote update\n");
  await git(repos.workspace.work, ["commit", "-am", "remote update"]);
  await git(repos.workspace.work, ["push", "origin", "main"]);

  const workspace = join(stateDir, "workspace");
  await writeFile(join(workspace, "notes", "today.md"), "local update\n");
  await git(workspace, [
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=portable test",
    "commit",
    "-am",
    "local update",
  ]);

  const second = startLauncher({ portableDir: source.portableDir, env: env() });
  try {
    await waitFor(() => second.output.includes("soul-server를 시작했습니다"), { timeoutMs: 180000 });
    await waitFor(async () => (await readFile(childMarker(stateDir), "utf8")) !== markerAfterFirst, {
      timeoutMs: 60000,
    });
    assert.match(second.output, /경고: workspace를 앞으로 보내지 못했습니다/);
    assert.equal(await readFile(join(workspace, "notes", "today.md"), "utf8"), "local update\n");
    assert.ok(existsSync(join(stateDir, "common", "skills", "readme.md")));
  } finally {
    second.stop();
    await second.exit;
  }
});
