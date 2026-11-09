import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitEnv } from "../lib/git.mjs";
import { buildCodexLoginEnv, ensureCodexLogin } from "../lib/environment.mjs";
import { makeTempRoot } from "./helpers.mjs";

const PARENT_SECRETS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ATOM_API_KEY",
  "ANTHROPIC_API_KEY",
  "SOULSTREAM_BEARER_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

async function withParentSecrets(fn) {
  const saved = new Map();
  for (const key of PARENT_SECRETS) {
    saved.set(key, process.env[key]);
    process.env[key] = "parent-secret-value";
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("git child env는 부모의 비밀값을 통째로 물려받지 않는다", async () => {
  await withParentSecrets(() => {
    const stateRoot = "/state-root";
    const env = gitEnv(stateRoot);
    for (const key of PARENT_SECRETS) {
      assert.equal(key in env, false, `git env에 ${key}가 있습니다.`);
    }
    assert.equal(env.HOME, join(stateRoot, "home"));
    assert.equal(env.GIT_CONFIG_GLOBAL, join(stateRoot, "git", "gitconfig"));
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.ok(env.PATH !== undefined || env.Path !== undefined, "PATH가 없습니다.");
  });
});

test("Codex 로그인 child env에는 CODEX_HOME과 OS 키만 있다", async () => {
  await withParentSecrets(() => {
    const stateRoot = "/state-root";
    const env = buildCodexLoginEnv(stateRoot);
    assert.equal(env.CODEX_HOME, join(stateRoot, "codex"));
    assert.equal(env.HOME, join(stateRoot, "home"));
    for (const key of PARENT_SECRETS) {
      assert.equal(key in env, false, `Codex 로그인 env에 ${key}가 있습니다.`);
    }
    for (const key of ["AUTH_BEARER_TOKEN", "SOULSTREAM_NODE_ID", "ATOM_SERVER_URL", "AGENT_COMMON_FILES_DIR"]) {
      assert.equal(key in env, false, `Codex 로그인 env에 soul-server 값(${key})이 있습니다.`);
    }
  });
});

test("Codex 로그인 status를 실제로 띄울 때도 같은 env만 준다", async (t) => {
  if (process.platform === "win32") {
    t.skip("윈도우에서는 sh 가짜 실행 파일을 쓰지 않습니다.");
    return;
  }
  const root = await makeTempRoot("codex-env");
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const fakeCodex = join(bin, "codex");
  await writeFile(
    fakeCodex,
    `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  env > "$CODEX_HOME/login-env.txt"
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  await chmod(fakeCodex, 0o755);

  const savedSkip = process.env.PORTABLE_NODE_TEST_SKIP_CODEX_LOGIN;
  delete process.env.PORTABLE_NODE_TEST_SKIP_CODEX_LOGIN;
  try {
    await withParentSecrets(() => ensureCodexLogin({ stateRoot, codexExecutable: fakeCodex }));
  } finally {
    if (savedSkip === undefined) delete process.env.PORTABLE_NODE_TEST_SKIP_CODEX_LOGIN;
    else process.env.PORTABLE_NODE_TEST_SKIP_CODEX_LOGIN = savedSkip;
  }

  const dumped = await readFile(join(stateRoot, "codex", "login-env.txt"), "utf8");
  const names = new Set(dumped.split("\n").map((line) => line.slice(0, line.indexOf("="))));
  for (const key of [...PARENT_SECRETS, "AUTH_BEARER_TOKEN", "SOULSTREAM_NODE_ID"]) {
    assert.equal(names.has(key), false, `Codex 로그인 child env에 ${key}가 있습니다.`);
  }
  assert.ok(names.has("CODEX_HOME"), "CODEX_HOME이 없습니다.");
  assert.ok(names.has("HOME"), "HOME이 없습니다.");
});
