import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeCredentialHelper } from "../lib/git.mjs";
import { cloneWorkspace } from "../lib/git.mjs";
import { TOKEN, git, makeTempRoot, startFakeOrchestrator } from "./helpers.mjs";

test("부분 복제를 광고하지 않는 서버면 복제 전에 멈춘다", async (t) => {
  const root = await makeTempRoot("partial-clone");
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitRoot = join(root, "git");
  await mkdir(gitRoot, { recursive: true });

  // uploadpack.allowFilter=false인 bare 리포를 하나 만든다.
  const bare = join(gitRoot, "seosoyoung_workspace.git");
  const work = join(root, "work");
  await git(root, ["init", "--bare", "--quiet", bare]);
  await git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"], { allowFail: true });
  await git(bare, ["config", "uploadpack.allowFilter", "false"]);
  await mkdir(work, { recursive: true });
  await git(work, ["init", "--quiet", "-b", "main"]);
  await git(work, ["config", "user.email", "test@example.invalid"]);
  await git(work, ["config", "user.name", "portable test"]);
  await writeFile(join(work, "README.md"), "no filter here\n");
  await git(work, ["add", "-A"]);
  await git(work, ["commit", "--quiet", "-m", "init"]);
  await git(work, ["remote", "add", "origin", bare]);
  await git(work, ["push", "--quiet", "origin", "main"]);

  const orch = await startFakeOrchestrator({ root, gitRoot });
  t.after(orch.close);

  const stateRoot = join(root, "state");
  await mkdir(join(stateRoot, "git"), { recursive: true });
  await writeFile(
    join(stateRoot, "node.json"),
    `${JSON.stringify({ token: TOKEN, upstream: orch.url })}\n`,
  );
  await writeCredentialHelper(stateRoot, { nodePath: process.execPath });

  const target = join(root, "target");
  await assert.rejects(
    cloneWorkspace({
      stateRoot,
      target,
      upstream: orch.url,
      proxyPath: "/api/node/git/seosoyoung_workspace",
      sparsePatterns: ["/*"],
    }),
    (error) => error.code === "PARTIAL_CLONE_UNSUPPORTED",
  );
  assert.equal(existsSync(target), false, "부분 복제가 불가능한데 대상 폴더를 만들었습니다.");
});
