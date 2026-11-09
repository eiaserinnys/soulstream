import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeCredentialHelper } from "../lib/git.mjs";
import { makeTempRoot, run } from "./helpers.mjs";

async function ask(helperPath, statePath, host, path, operation = "get", protocol = "http") {
  const input =
    operation === "get"
      ? `${protocol === null ? "" : `protocol=${protocol}\n`}host=${host}\npath=${path}\n\n`
      : "";
  return run(process.execPath, [helperPath, statePath, operation], { input });
}

test("자격 도우미는 정해진 두 경로에만 토큰을 준다", async (t) => {
  const root = await makeTempRoot("credential");
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  await mkdir(join(stateDir, "git"), { recursive: true });
  const statePath = join(stateDir, "node.json");
  await writeFile(statePath, `${JSON.stringify({ token: "tok-secret", upstream: "http://127.0.0.1:43111" })}\n`);
  const { helperPath } = await writeCredentialHelper(stateDir, { nodePath: process.execPath });

  const allowed = await ask(helperPath, statePath, "127.0.0.1:43111", "api/node/git/seosoyoung_workspace");
  assert.equal(allowed.code, 0);
  assert.equal(allowed.stdout, "username=soulstream-node\npassword=tok-secret\n");
  const allowedCommon = await ask(helperPath, statePath, "127.0.0.1:43111", "api/node/git/seosoyoung-common");
  assert.equal(allowedCommon.stdout, "username=soulstream-node\npassword=tok-secret\n");

  for (const [host, path] of [
    ["127.0.0.1:43111", "api/node/git/other"],
    ["evil.example", "api/node/git/seosoyoung_workspace"],
    ["127.0.0.1:9", "api/node/git/seosoyoung-common"],
    ["127.0.0.1:43111", "api/node/git/seosoyoung_workspace/extra"],
  ]) {
    const denied = await ask(helperPath, statePath, host, path);
    assert.equal(denied.stdout, "", `${host} ${path}에 응답했습니다.`);
    assert.equal(denied.stderr, "");
  }

  for (const operation of ["store", "erase"]) {
    const result = await ask(helperPath, statePath, "127.0.0.1:43111", "api/node/git/seosoyoung_workspace", operation);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  }
});

test("자격 도우미는 저장된 upstream과 다른 scheme에는 토큰을 주지 않는다", async (t) => {
  const root = await makeTempRoot("credential-protocol");
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  await mkdir(join(stateDir, "git"), { recursive: true });
  const statePath = join(stateDir, "node.json");
  await writeFile(statePath, `${JSON.stringify({ token: "tok-secret", upstream: "https://127.0.0.1:43111" })}\n`);
  const { helperPath } = await writeCredentialHelper(stateDir, { nodePath: process.execPath });

  const https = await ask(helperPath, statePath, "127.0.0.1:43111", "api/node/git/seosoyoung_workspace", "get", "https");
  assert.equal(https.stdout, "username=soulstream-node\npassword=tok-secret\n");

  const http = await ask(helperPath, statePath, "127.0.0.1:43111", "api/node/git/seosoyoung_workspace", "get", "http");
  assert.equal(http.stdout, "", "저장된 upstream은 https인데 http 요청에 토큰을 줬습니다.");

  const missing = await ask(helperPath, statePath, "127.0.0.1:43111", "api/node/git/seosoyoung_workspace", "get", null);
  assert.equal(missing.stdout, "", "scheme이 없는 요청에 토큰을 줬습니다.");
});
