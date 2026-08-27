import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const shellScripts = [
  "common.sh",
  "bootstrap.sh",
  "clean-run-common.sh",
  "clean-run.sh",
  "start.sh",
  "stop.sh",
  "restart-node.sh",
  "status.sh",
  "smoke.sh",
  "fault-harness.sh",
];

test("clean-run resets before bootstrap and always stops the isolated stack", () => {
  const cleanRun = readFileSync(join(directory, "clean-run.sh"), "utf8");
  const provenanceAt = cleanRun.indexOf("print_fresh_lab_provenance");
  const resetAt = cleanRun.indexOf("reset_lab_mutable_state");
  const bootstrapAt = cleanRun.indexOf('"$SCRIPT_DIR/bootstrap.sh"');
  const startAt = cleanRun.indexOf('"$SCRIPT_DIR/start.sh"');
  const harnessAt = cleanRun.indexOf('"$SCRIPT_DIR/fault-harness.sh"');

  assert.ok(provenanceAt >= 0, "clean-run does not print fresh provenance");
  assert.ok(resetAt > provenanceAt, "clean-run reset must follow provenance output");
  assert.ok(bootstrapAt > resetAt, "bootstrap must follow reset");
  assert.ok(startAt > bootstrapAt, "start must follow bootstrap");
  assert.ok(harnessAt > startAt, "harness must follow start");
  assert.match(cleanRun, /trap cleanup EXIT/);
  assert.match(cleanRun, /LAB_CLAUDE_AUTH_SOURCE="\$LAB_CLAUDE_AUTH_FILE"/);
  assert.match(cleanRun, /fault-h2-product-mutation\.mjs/);
  assert.match(cleanRun, /apply "\$LAB_REPO" "\$h2_mutation_backup"/);
  assert.match(cleanRun, /restore "\$LAB_REPO" "\$h2_mutation_backup"/);
});

test("mutable-state reset preserves only the lab credential", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-clean-state-"));
  try {
    for (const path of ["state/config", "logs", "outbox", "runner-state", "workspace"]) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, "residue"), "dirty\n");
    }
    writeFileSync(join(root, "state", "claude-auth.json"), "lab-auth\n");
    chmodSync(join(root, "state", "config", "residue"), 0o444);
    chmodSync(join(root, "state", "config"), 0o555);

    const outcome = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; source "$2"; LAB_ROOT="$3"; LAB_DEFAULT_ROOT="$3"; reset_lab_mutable_state',
        "lab-test",
        join(directory, "common.sh"),
        join(directory, "clean-run-common.sh"),
        root,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(readFileSync(join(root, "state", "claude-auth.json"), "utf8"), "lab-auth\n");
    for (const path of ["logs", "outbox", "runner-state", "workspace"]) {
      assert.deepEqual(execFileSync("find", [join(root, path), "-mindepth", "1"], {
        encoding: "utf8",
      }).trim(), "");
    }
    assert.equal(existsSync(join(root, "state", "config")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provenance output fetches origin main without moving the checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-clean-provenance-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  try {
    execFileSync("git", ["init", "--bare", origin], { stdio: "pipe" });
    execFileSync("git", ["init", seed], { stdio: "pipe" });
    execFileSync("git", ["-C", seed, "config", "user.email", "lab@example.invalid"]);
    execFileSync("git", ["-C", seed, "config", "user.name", "Lab Test"]);
    writeFileSync(join(seed, "fixture.txt"), "first\n");
    execFileSync("git", ["-C", seed, "add", "fixture.txt"]);
    execFileSync("git", ["-C", seed, "commit", "-m", "first"], { stdio: "pipe" });
    execFileSync("git", ["-C", seed, "branch", "-M", "main"]);
    execFileSync("git", ["-C", seed, "remote", "add", "origin", origin]);
    execFileSync("git", ["-C", seed, "push", "origin", "main"], { stdio: "pipe" });
    execFileSync("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);
    execFileSync("git", ["clone", origin, clone], { stdio: "pipe" });
    const checkout = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    writeFileSync(join(seed, "fixture.txt"), "second\n");
    execFileSync("git", ["-C", seed, "add", "fixture.txt"]);
    execFileSync("git", ["-C", seed, "commit", "-m", "second"], { stdio: "pipe" });
    execFileSync("git", ["-C", seed, "push", "origin", "main"], { stdio: "pipe" });
    const freshOriginMain = execFileSync("git", ["-C", seed, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    const outcome = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; source "$2"; LAB_REPO="$3"; print_fresh_lab_provenance',
        "lab-test",
        join(directory, "common.sh"),
        join(directory, "clean-run-common.sh"),
        clone,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, new RegExp(`checkout=${checkout}`));
    assert.match(outcome.stdout, new RegExp(`origin_main=${freshOriginMain}`));
    assert.equal(
      execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      checkout,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all lab shell scripts pass bash syntax validation", () => {
  for (const script of shellScripts) {
    execFileSync("bash", ["-n", join(directory, script)], { stdio: "pipe" });
  }
});

test("the lab identity is explicit and production ports are guarded", () => {
  const envExample = readFileSync(join(directory, ".env.example"), "utf8");
  assert.match(envExample, /LAB_REPO=\/home\/eias\/services\/soulstream-lab\/repo/);
  assert.match(envExample, /LAB_ORCH_PORT=5300/);
  assert.match(envExample, /LAB_NODE_PORT=3116/);
  assert.match(envExample, /LAB_POSTGRES_PORT=5437/);
  assert.match(envExample, /LAB_POSTGRES_CONTAINER=soulstream-lab-postgres/);

  const common = readFileSync(join(directory, "common.sh"), "utf8");
  assert.match(common, /assert_safe_port "\$LAB_ORCH_PORT" 5200/);
  assert.match(common, /assert_safe_port "\$LAB_NODE_PORT" 3105/);
  assert.match(common, /assert_safe_port "\$LAB_POSTGRES_PORT" 5432 5433 5434 5435 5436/);
  assert.match(common, /com\.soulstream\.lab/);
});

test("an available port is a successful guard result", () => {
  execFileSync(
    "bash",
    ["-c", `source "$1"; assert_port_free 65431`, "lab-test", join(directory, "common.sh")],
    { stdio: "pipe" },
  );
});

test("database and process mutations are scoped to lab-owned targets", () => {
  const sources = shellScripts
    .map((script) => readFileSync(join(directory, script), "utf8"))
    .join("\n");
  assert.doesNotMatch(sources, /docker (stop|start|exec).*serendipity-postgres/);
  assert.doesNotMatch(sources, /haniel_(pull|restart|start|stop)|service-command/);
  assert.match(sources, /unset DATABASE_URL/);
  assert.match(sources, /lab_database_url/);
  assert.match(sources, /migrate\.mjs" initialize/);
  assert.match(sources, /kill -TERM/);
  assert.doesNotMatch(sources, /kill -KILL|kill -9/);
  assert.match(sources, /setsid -f bash -c/);
  assert.match(sources, /\/proc\/\$\$\/fd\/\*/);
});

test("bootstrap initializes only after dependencies and builds exist", () => {
  const bootstrap = readFileSync(join(directory, "bootstrap.sh"), "utf8");
  const installAt = bootstrap.indexOf('pnpm --dir "$LAB_REPO" install');
  const initializeAt = bootstrap.indexOf('migrate.mjs" initialize');
  assert.ok(installAt >= 0 && initializeAt > installAt);
  assert.doesNotMatch(bootstrap, /flock -u 9|exec 9>&-/);
  assert.match(
    bootstrap,
    /HANIEL_BACKUP_DIR="\$LAB_ROOT\/state\/database-release\/\$release_id"/,
  );

  const start = readFileSync(join(directory, "start.sh"), "utf8");
  assert.match(start, /migrate\.mjs" verify/);
  assert.doesNotMatch(start, /migrate\.mjs" initialize/);
});

test("status checks both volatile registry and durable node heartbeat", () => {
  const status = readFileSync(join(directory, "status.sh"), "utf8");
  assert.match(status, /api_get_to_file \/api\/nodes/);
  assert.match(status, /node\.nodeId === "eias-lab"/);
  assert.match(status, /soulstream_node_heartbeats WHERE node_id = 'eias-lab'/);
});

test("smoke validation fixes both turns to one session and restarts only the node", () => {
  const smoke = readFileSync(join(directory, "smoke.sh"), "utf8");
  assert.match(smoke, /LAB_TURN_1_OK/);
  assert.match(smoke, /restart-node\.sh/);
  assert.match(smoke, /api\/sessions\/\$session_id\/intervene/);
  assert.match(smoke, /LAB_TURN_2_OK/);
  assert.doesNotMatch(smoke, /durable_next_turn/);
});

test("fault harness is lab-only, bounded, and inventories transparent plus fault scenarios", () => {
  const wrapper = readFileSync(join(directory, "fault-harness.sh"), "utf8");
  const runtime = readFileSync(join(directory, "fault-harness-runtime.mjs"), "utf8");
  const processFaults = readFileSync(join(directory, "fault-harness-process.mjs"), "utf8");
  const scenarios = readFileSync(join(directory, "fault-scenarios.mjs"), "utf8");
  const transparencyScenarios = readFileSync(
    join(directory, "fault-scenarios-transparency.mjs"),
    "utf8",
  );
  const deliveryScenarios = readFileSync(
    join(directory, "fault-scenarios-delivery.mjs"),
    "utf8",
  );
  assert.match(wrapper, /load_lab_env/);
  assert.match(wrapper, /export LAB_ROOT/);
  assert.match(wrapper, /SOULSTREAM_HEAVY_LOCK_HELD=1/);
  assert.match(wrapper, /flock -w 300 \/tmp\/soulstream-heavy-verify\.lock/);
  assert.match(wrapper, /LAB_HARNESS_PROCESS_CEILING_SECONDS/);
  assert.match(wrapper, /run_with_process_group_ceiling/);
  assert.match(wrapper, /fault-harness-suite\.mjs/);
  assert.match(wrapper, /"\$suite_entry" "\$1"/);
  assert.match(wrapper, /\$LAB_REPO\/scripts\/lab-node\/fault-harness\.mjs/);
  assert.match(runtime, /unsafe LAB_ROOT/);
  assert.match(runtime, /protectedPorts\.includes/);
  assert.match(runtime, /soulstream-lab-/);
  assert.match(runtime, /waitForRunnerOperationStateSince/);
  assert.match(runtime, /waitForAdoptionWindow/);
  assert.match(scenarios, /reserveAttemptedBeforeSettlement: false/);
  assert.match(scenarios, /interventionAttemptedBeforeSettlement: false/);
  assert.doesNotMatch(scenarios, /runner execution settled without host restart/);
  assert.doesNotMatch(
    runtime + processFaults + scenarios + transparencyScenarios + deliveryScenarios,
    /serendipity-postgres|haniel_(pull|restart|start|stop)/,
  );
  assert.match(scenarios, /F9 injection and lab restoration failed/);
  assert.match(scenarios, /dead-owner injection and lab restoration failed/);
  assert.match(scenarios, /runner-death-live-host injection and cleanup failed/);
  assert.match(scenarios, /activate-rollback injection and cleanup failed/);
  assert.match(scenarios, /activate-rollback contract failed/);
  assert.match(scenarios, /semanticReachCount: reach\.semanticReachCount/);
  assert.match(runtime, /CREATE SEQUENCE lab_fault_execution_acquire_reach_seq/);
  assert.match(runtime, /nextval\('lab_fault_execution_acquire_reach_seq'/);
  assert.match(runtime, /lab_fault_execution_acquire_generation_seq/);
  assert.match(runtime, /lab_fault_execution_acquire_command_seq/);
  assert.match(runtime, /last_value/);
  assert.match(runtime, /DROP SEQUENCE IF EXISTS lab_fault_execution_acquire_reach_seq/);
  assert.doesNotMatch(runtime, /return \{ semanticReachCount: 1 \}/);
  assert.match(runtime, /terminateObservedLabRunnerRegistration/);
  assert.ok(
    scenarios.indexOf("registrationPresent: (await runtime.runnerExecutionRegistration")
      < scenarios.indexOf("runtime.terminateObservedLabRunnerRegistration"),
  );
  assert.match(scenarios, /waitForRunnerOperationStateSince/);
  assert.match(scenarios, /followupAdmissionDistinct/);
  assert.ok(
    scenarios.indexOf('recorder.event("fault_reached"')
      < scenarios.indexOf("activate rollback left the spawned child live"),
  );
  for (const scenario of [
    "steady-state",
    "restart-adopt",
    "restart-intervention-window",
  ]) {
    assert.match(
      transparencyScenarios,
      new RegExp(`(?:async )?["']?${scenario}["']?\\(`),
    );
  }
  for (const scenario of [
    "F1",
    "F11",
    "F9",
    "dead-owner",
    "runner-death-live-host",
    "activate-rollback",
    "F7",
  ]) {
    assert.match(scenarios, new RegExp(`(?:async )?["']?${scenario}["']?\\(`));
  }
  for (const scenario of [
    "delivery-revival",
    "delivery-exact-once",
    "delivery-fifo",
    "delivery-accepted-cas",
  ]) {
    assert.match(deliveryScenarios, new RegExp(`async ["']${scenario}["']\\(`));
  }
});

test("harness deadlines are 60 seconds for intervention acceptance and 180 seconds hard", () => {
  const common = readFileSync(join(directory, "common.sh"), "utf8");
  assert.match(common, /LAB_INTERVENTION_ACCEPTANCE_SECONDS=60/);
  assert.match(common, /LAB_HARNESS_PROCESS_CEILING_SECONDS=180/);

  const smoke = readFileSync(join(directory, "smoke.sh"), "utf8");
  assert.match(smoke, /LAB_INTERVENTION_ACCEPTANCE_SECONDS/);
  assert.doesNotMatch(smoke, /LAB_SMOKE_TIMEOUT_SECONDS:-600/);
});

test("the process ceiling kills the whole child process group", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "lab-process-ceiling-"));
  mkdirSync(join(root, "state"));
  const fixture = join(root, "ceiling-fixture.cjs");
  const childPidPath = join(root, "child.pid");
  writeFileSync(fixture, `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    fs.writeFileSync(process.env.LAB_CHILD_PID_PATH, String(child.pid));
    setInterval(() => {}, 1000);
  `);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const outcome = await runCommand(
    "bash",
    [
      "-c",
      'source "$1"; LAB_ROOT="$2"; run_with_process_group_ceiling 1 "$3" env LAB_CHILD_PID_PATH="$4" node "$3"',
      "lab-test",
      join(directory, "common.sh"),
      root,
      fixture,
      childPidPath,
    ],
    { timeout: 10_000 },
  );
  assert.equal(outcome.status, 124, outcome.stderr);
  assert.equal(existsSync(childPidPath), true, "fixture did not publish its child pid");
  const childPid = Number(readFileSync(childPidPath, "utf8"));
  await waitForPidExit(childPid);
});

test("stop rejects zombie residue, reaps runner groups, and GCs only orphans", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "lab-runner-stop-"));
  const releases = join(root, "state", "runner-releases");
  const runnerState = join(root, "runner-state");
  const referencedRelease = "sha256-referenced";
  const orphanRelease = "sha256-orphan";
  const referencedDirectory = join(releases, referencedRelease);
  const orphanDirectory = join(releases, orphanRelease);
  const runnerEntry = join(orphanDirectory, "runner_entry.js");
  const childPidPath = join(root, "runner-child.pid");
  const zombiePidPath = join(root, "runner-zombie.pid");
  mkdirSync(join(runnerState, "referenced"), { recursive: true });
  mkdirSync(referencedDirectory, { recursive: true });
  mkdirSync(orphanDirectory, { recursive: true });
  writeFileSync(
    join(runnerState, "referenced", "runner-config.json"),
    JSON.stringify({ codeSha: referencedRelease }),
  );
  writeFileSync(runnerEntry, `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    fs.writeFileSync(process.env.LAB_CHILD_PID_PATH, String(child.pid));
    const zombie = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    fs.writeFileSync(process.env.LAB_ZOMBIE_PID_PATH, String(zombie.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  `);

  const runner = spawn(
    process.execPath,
    [runnerEntry, "--config", join(runnerState, "missing", "runner-config.json")],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        LAB_CHILD_PID_PATH: childPidPath,
        LAB_ZOMBIE_PID_PATH: zombiePidPath,
      },
    },
  );
  const runnerClosed = waitForClose(runner);
  t.after(async () => {
    try { process.kill(-runner.pid, "SIGKILL"); } catch {}
    await runnerClosed;
    try { chmodSync(orphanDirectory, 0o755); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  await waitForFile(childPidPath);
  await waitForFile(zombiePidPath);
  const childPid = Number(readFileSync(childPidPath, "utf8"));
  const zombiePid = Number(readFileSync(zombiePidPath, "utf8"));
  await waitForPidState(zombiePid, "Z");
  chmodSync(runnerEntry, 0o444);
  chmodSync(orphanDirectory, 0o555);

  const contamination = await runCommand(
    "bash",
    [
      "-c",
      'source "$1"; LAB_ROOT="$2"; pid_is_owned_runner "$3"; pgid="$(ps -o pgid= -p "$3" | tr -d " ")"; wait_for_empty_process_group zombie-mutation "$pgid" 2',
      "lab-test",
      join(directory, "common.sh"),
      root,
      String(runner.pid),
    ],
    { timeout: 3_000 },
  );
  assert.equal(contamination.status, 1);
  assert.match(contamination.stderr, /infra contamination.*live=2.*zombie=1/);

  const outcome = await runCommand(
    "bash",
    [
      "-c",
      'source "$1"; LAB_ROOT="$2"; LAB_DEFAULT_ROOT="$2"; stop_owned_runners; gc_orphan_runner_releases',
      "lab-test",
      join(directory, "common.sh"),
      root,
    ],
    { timeout: 10_000 },
  );
  assert.equal(outcome.status, 0, outcome.stderr);
  await runnerClosed;
  await waitForPidExit(runner.pid);
  await waitForPidExit(childPid);
  await waitForPidExit(zombiePid);
  assert.equal(existsSync(referencedDirectory), true);
  assert.equal(existsSync(orphanDirectory), false);
});

test("bootstrap repairs a narrow deleted-branch refspec to fetch main", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-refspec-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  try {
    execFileSync("git", ["init", "--bare", origin], { stdio: "pipe" });
    execFileSync("git", ["init", seed], { stdio: "pipe" });
    execFileSync("git", ["-C", seed, "config", "user.email", "lab@example.invalid"]);
    execFileSync("git", ["-C", seed, "config", "user.name", "Lab Test"]);
    writeFileSync(join(seed, "README.md"), "fixture\n");
    execFileSync("git", ["-C", seed, "add", "README.md"]);
    execFileSync("git", ["-C", seed, "commit", "-m", "fixture"], { stdio: "pipe" });
    execFileSync("git", ["-C", seed, "branch", "-M", "main"]);
    execFileSync("git", ["-C", seed, "remote", "add", "origin", origin]);
    execFileSync("git", ["-C", seed, "push", "origin", "main"], { stdio: "pipe" });
    execFileSync("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);
    execFileSync("git", ["clone", origin, clone], { stdio: "pipe" });
    execFileSync("git", ["-C", clone, "config", "--replace-all", "remote.origin.fetch",
      "+refs/heads/lab-node:refs/remotes/origin/lab-node"]);
    execFileSync("git", ["-C", clone, "update-ref", "-d", "refs/remotes/origin/main"]);

    const outcome = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; ensure_main_fetch_refspec "$2"',
        "lab-test",
        join(directory, "common.sh"),
        clone,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(
      execFileSync("git", ["-C", clone, "config", "--get-all", "remote.origin.fetch"],
        { encoding: "utf8" }).trim(),
      "+refs/heads/*:refs/remotes/origin/*",
    );
    assert.equal(
      execFileSync("git", ["-C", clone, "rev-parse", "refs/remotes/origin/main"],
        { encoding: "utf8" }).trim(),
      execFileSync("git", ["-C", seed, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForFile(path) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`file did not appear: ${path}`);
}

async function waitForPidExit(pid) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} remained alive`);
}

async function waitForPidState(pid, prefix) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
      if (state.startsWith(prefix)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} never reached state ${prefix}`);
}

function waitForClose(child) {
  return new Promise((resolve) => child.once("close", resolve));
}

function runCommand(command, args, { timeout }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}
