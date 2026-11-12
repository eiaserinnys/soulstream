#!/usr/bin/env node
import { readFile, mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { platformKey, writeConfigGeneration } from "./lib/config.mjs";
import { awaitApproval, defaultNodeId, startPairing, validateNodeId } from "./lib/pairing.mjs";
import { alignCheckout, assertGit, gitEnv, run } from "./lib/git.mjs";
import {
  ensureRuntime,
  fetchCurrentRelease,
  installRelease,
  isPathInside,
  readRuntimeLock,
  readRuntimeMarker,
  releaseKey,
  runtimeInstallDir,
  runtimePlan,
} from "./lib/release.mjs";
import { ensureCodexLogin, ensurePorts, ensurePythonWrapper, prepareRelease } from "./lib/environment.mjs";
import { installRuntimes, prepareCandidate, rollbackToPrevious, startCandidate } from "./lib/activation.mjs";
import { assertRunnerStatePathCompatible } from "./lib/paths.mjs";
import { isRepeatedReentry } from "./lib/reentry.mjs";
import { ensureStateLayout, readJson, writeStateFile } from "./lib/state.mjs";

const REENTRY_EXIT_CODE = 75;
const RETRY_DELAY_MS = 30000;

const log = (message) => process.stdout.write(`[portable-node] ${message}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function resolvePortableDir() {
  if (process.env.PORTABLE_NODE_DIR) return resolve(process.env.PORTABLE_NODE_DIR);
  const here = dirname(fileURLToPath(import.meta.url));
  if (basename(here) === "boot") {
    throw new Error("PORTABLE_NODE_DIR가 필요합니다. start.sh 또는 start.cmd로 실행하십시오.");
  }
  return here;
}

async function loadDefaults(portableDir) {
  const path = process.env.PORTABLE_NODE_DEFAULTS ?? join(portableDir, "defaults.json");
  const defaults = JSON.parse(await readFile(path, "utf8"));
  if (!defaults.upstream) throw new Error("defaults.json에 upstream이 없습니다.");
  return defaults;
}

async function loadLock(portableDir) {
  if (process.env.PORTABLE_NODE_RUNTIME_LOCK) {
    const lock = JSON.parse(await readFile(process.env.PORTABLE_NODE_RUNTIME_LOCK, "utf8"));
    if (lock.schema_version !== 1 || !lock.runtimes) throw new Error("runtime lock 형식이 올바르지 않습니다.");
    return lock;
  }
  return readRuntimeLock(portableDir);
}

async function askQuestions(defaultName) {
  const injected = process.env.PORTABLE_NODE_ANSWERS;
  if (injected) {
    const parsed = JSON.parse(injected);
    return { nodeId: parsed.node_id };
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      "첫 실행 질문에 답할 터미널이 없습니다. PORTABLE_NODE_ANSWERS 환경변수로 node_id를 주십시오.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`노드 이름 [${defaultName}]: `)).trim();
    return { nodeId: answer.length > 0 ? answer : defaultName };
  } finally {
    rl.close();
  }
}

async function firstRun({ stateRoot, defaults }) {
  const suggested = defaultNodeId(hostname());
  const answers = await askQuestions(suggested);
  const nodeId = validateNodeId(answers.nodeId);
  log(`참여를 요청합니다: ${nodeId}`);
  const pairing = await startPairing({
    upstream: defaults.upstream,
    nodeId,
    timeoutMs: defaults.json_timeout_ms,
  });
  process.stdout.write(
    [
      "",
      "이 코드를 알려 승인을 요청하세요.",
      "",
      `    ${pairing.userCode}`,
      "",
      `(만료 ${new Date(pairing.expiresAt).toLocaleString()})`,
      "",
    ].join("\n"),
  );
  const approval = await awaitApproval({
    upstream: defaults.upstream,
    deviceCode: pairing.deviceCode,
    expiresAt: pairing.expiresAt,
    intervalSecs: defaults.pairing_poll_interval_secs,
    timeoutMs: defaults.json_timeout_ms,
    onPending: () => log("승인을 기다리는 중입니다…"),
  });
  const node = {
    schema_version: 1,
    node_id: approval.nodeId,
    company_pc: approval.companyPc,
    token: approval.token,
    upstream: defaults.upstream,
    node_ws_url: defaults.node_ws_url,
    paired_at: new Date().toISOString(),
    ports: {},
  };
  await writeStateFile(join(stateRoot, "node.json"), node);
  log("참여가 승인되었습니다.");
  return node;
}

async function waitForCurrent({ defaults, node }) {
  for (;;) {
    try {
      return await fetchCurrentRelease({
        upstream: defaults.upstream,
        token: node.token,
        timeoutMs: defaults.json_timeout_ms,
      });
    } catch (error) {
      if (error.code === "NOT_READY") {
        log(error.message);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
}

async function checkoutIsClean(repoRoot, stateRoot) {
  const status = await run("git", ["-C", repoRoot, "status", "--porcelain"], { env: gitEnv(stateRoot) });
  return status.code === 0 && status.stdout.trim() === "";
}

/**
 * 잠금 파일의 Node가 준비되어 있는지 본다. 다른 버전은 새 버전 폴더에 설치하고
 * 재진입을 요청하며, 지금 실행 중인 폴더는 절대 지우지 않는다.
 */
async function ensureNodeForPlan({ stateRoot, plan }) {
  const entry = plan.find((item) => item.kind === "node");
  const dir = runtimeInstallDir(stateRoot, "node", entry.version);
  const marker = await readRuntimeMarker(dir);
  const installed = Boolean(marker) && marker.sha256 === entry.sha256;
  const running = process.version === `v${entry.version}`;
  if (installed && running) return null;
  if (running) {
    if (!installed) {
      if (await isPathInside(dir, process.execPath)) {
        log("경고: 실행 중인 Node 런타임 폴더의 기록이 잠금 파일과 다릅니다. 지우지 않고 그대로 씁니다.");
        return null;
      }
      await ensureRuntime({ stateRoot, plan, kind: "node" });
    }
    return null;
  }
  if (!(await isPathInside(dir, process.execPath))) {
    await ensureRuntime({ stateRoot, plan, kind: "node" });
  }
  return { entry };
}

/** 재진입 요청을 기록한다. 같은 이유·키가 이미 기록돼 있으면 진행이 아니라 반복이다. */
async function requestReentry({ path, previous, reason, key, message, loopMessage }) {
  if (isRepeatedReentry(previous, reason, key)) throw new Error(loopMessage);
  await writeStateFile(path, { reason, key, at: new Date().toISOString() });
  log(message);
}

/**
 * 판 전환 준비. child를 멈추기 전에 구성·payload·런타임·bind를 모두 끝낸다.
 * 하나라도 실패하면 아무것도 바꾸지 않고 현재 판을 계속 실행한다.
 */
async function stageSwitch({ context, release }) {
  const configGeneration = await writeConfigGeneration({
    templatesDir: join(context.portableDir, "config"),
    stateRoot: context.stateRoot,
    configRoot: join(context.stateRoot, "config"),
    hostPort: context.ports.mcp,
  });
  const installed = await installRelease({
    stateRoot: context.stateRoot,
    upstream: context.defaults.upstream,
    token: context.node.token,
    release,
    log,
  });
  const alignment = await alignCheckout({
    stateRoot: context.stateRoot,
    root: context.repoRoot,
    sourceCommit: release.source_commit,
  });
  if (!alignment.aligned) {
    return { ok: false, message: alignment.message ?? "작업 트리의 변경을 보존합니다." };
  }
  const lock = await loadLock(context.portableDir);
  const plan = runtimePlan(lock, platformKey());
  const nodeChange = await ensureNodeForPlan({ stateRoot: context.stateRoot, plan });
  const runtimes = await installRuntimes({ stateRoot: context.stateRoot, plan, log });
  await prepareRelease({
    stateRoot: context.stateRoot,
    defaults: context.defaults,
    node: context.node,
    configDir: configGeneration.dir,
    releaseDir: installed.dir,
    runtimes,
    ports: context.ports,
    repoRoot: context.repoRoot,
  });
  return { ok: true, nodeChange };
}

function makeUpdateChecker(context) {
  const switchState = context.switchState;
  return async () => {
    if (switchState.switching || context.updatesDisabled) return;
    switchState.switching = true;
    try {
      const current = await fetchCurrentRelease({
        upstream: context.defaults.upstream,
        token: context.node.token,
        timeoutMs: context.defaults.json_timeout_ms,
      });
      if (current.sha256 === context.active.sha256 && current.source_commit === context.active.source_commit) {
        switchState.failedKey = null;
        return;
      }
      const key = releaseKey(current);
      if (switchState.failedKey === key) return;
      if (!(await checkoutIsClean(context.repoRoot, context.stateRoot))) {
        log("경고: 소스 작업 트리에 변경이 있어 판 전환을 보류합니다. 변경을 보존합니다.");
        return;
      }
      log("새 판이 있습니다. child를 멈추기 전에 준비합니다.");
      try {
        const staged = await stageSwitch({ context, release: current });
        if (!staged.ok) {
          log(`경고: 판 전환을 보류합니다. ${staged.message}`);
          return;
        }
        if (staged.nodeChange) {
          await requestReentry({
            path: context.reentryPath,
            previous: context.reentry,
            reason: "node",
            key: `${staged.nodeChange.entry.version}:${staged.nodeChange.entry.sha256}`,
            message: `Node ${staged.nodeChange.entry.version}으로 다시 시작합니다.`,
            loopMessage: "실행기를 다시 시작해도 Node 런타임이 잠금 파일과 맞지 않습니다.",
          });
        }
        log("준비를 마쳤습니다. child를 정상 종료하고 새 판으로 재진입합니다.");
        await context.supervisor.stop("switch");
        process.exit(REENTRY_EXIT_CODE);
      } catch (error) {
        switchState.failedKey = key;
        log(`경고: 새 판으로 전환하지 못했습니다. 현재 판을 계속 실행합니다. ${error.message}`);
      }
    } finally {
      switchState.switching = false;
    }
  };
}

async function main() {
  const portableDir = resolvePortableDir();
  const stateRoot = process.env.PORTABLE_NODE_STATE_DIR
    ? resolve(process.env.PORTABLE_NODE_STATE_DIR)
    : join(portableDir, ".state");
  const repoRoot = process.env.PORTABLE_NODE_REPO_ROOT
    ? resolve(process.env.PORTABLE_NODE_REPO_ROOT)
    : dirname(portableDir);

  await ensureStateLayout(stateRoot);
  assertRunnerStatePathCompatible(join(stateRoot, "r"));
  const reentryPath = join(stateRoot, "reentry.json");
  const reentry = await readJson(reentryPath);
  const defaults = await loadDefaults(portableDir);
  const lock = await loadLock(portableDir);

  let node = await readJson(join(stateRoot, "node.json"));
  if (!node) node = await firstRun({ stateRoot, defaults });

  await assertGit();

  const release = await waitForCurrent({ defaults, node });
  const alignment = await alignCheckout({ stateRoot, root: repoRoot, sourceCommit: release.source_commit });
  if (alignment.aligned && alignment.changed) {
    await requestReentry({
      path: reentryPath,
      previous: reentry,
      reason: "checkout",
      key: release.source_commit,
      message: "소스 판을 릴리스에 맞췄습니다. 실행기를 다시 시작합니다.",
      loopMessage: "소스 판을 맞춘 뒤에도 커밋이 되돌아갑니다. 작업 트리를 확인하십시오.",
    });
    process.exit(REENTRY_EXIT_CODE);
  }
  if (!alignment.aligned) log(`경고: ${alignment.message}`);

  const plan = runtimePlan(lock, platformKey());
  const nodeChange = await ensureNodeForPlan({ stateRoot, plan });
  if (nodeChange) {
    const { entry } = nodeChange;
    await requestReentry({
      path: reentryPath,
      previous: reentry,
      reason: "node",
      key: `${entry.version}:${entry.sha256}`,
      message: `Node ${entry.version}으로 다시 시작합니다.`,
      loopMessage: "실행기를 다시 시작해도 Node 런타임이 잠금 파일과 맞지 않습니다.",
    });
    process.exit(REENTRY_EXIT_CODE);
  }
  if (reentry) await rm(reentryPath, { force: true });

  const runtimes = await installRuntimes({ stateRoot, plan, log });
  await mkdir(join(stateRoot, "workspace"), { recursive: true, mode: 0o700 });
  const ports = await ensurePorts(stateRoot, node, (updated) =>
    writeStateFile(join(stateRoot, "node.json"), updated),
  );
  await ensurePythonWrapper(stateRoot, runtimes.python.executable);
  await ensureCodexLogin({ stateRoot, codexExecutable: runtimes.codex.executable });

  const previous = await readJson(join(stateRoot, "active-release.json"));
  let supervisor;
  let activeRelease = release;
  let updatesDisabled = false;
  try {
    const candidate = await prepareCandidate({
      stateRoot,
      defaults,
      node,
      runtimes,
      ports,
      release,
      templatesDir: join(portableDir, "config"),
      repoRoot,
      log,
    });
    supervisor = await startCandidate({ stateRoot, defaults, release, candidate, log });
  } catch (error) {
    log(`새 판 준비·기동에 실패했습니다: ${error.message}`);
    const restored = await rollbackToPrevious({
      stateRoot,
      defaults,
      node,
      runtimes,
      ports,
      previous,
      from: release,
      templatesDir: join(portableDir, "config"),
      repoRoot,
      log,
    });
    if (!restored) throw error;
    supervisor = restored.supervisor;
    activeRelease = previous;
    updatesDisabled = true;
    log(`이전 판(${String(previous.source_commit).slice(0, 12)})으로 기동했습니다. 새 판 문제를 확인한 뒤 다시 시작하십시오.`);
  }
  log(`soul-server를 시작했습니다 (${activeRelease.source_commit.slice(0, 12)}).`);
  log(`Claude 계정 등록은 기존 대시보드의 이 노드(${node.node_id}) 로그인 위치에서 하십시오.`);

  const context = {
    stateRoot,
    repoRoot,
    portableDir,
    defaults,
    node,
    runtimes,
    ports,
    reentryPath,
    reentry: null,
    active: { source_commit: activeRelease.source_commit, sha256: activeRelease.sha256 },
    updatesDisabled,
    switchState: { switching: false, failedKey: null },
    supervisor,
  };
  const checkForUpdate = makeUpdateChecker(context);
  const timer = setInterval(() => {
    checkForUpdate().catch((error) => log(`갱신 확인 실패: ${error.message}`));
  }, (defaults.check_interval_secs ?? 60) * 1000);
  timer.unref();

  const outcome = await supervisor.run();
  log(`감독을 마쳤습니다 (${outcome.stoppedBy}, 재시작 ${outcome.restarts}회).`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    log(`중단: ${error.message}`);
    process.exitCode = 1;
  });
