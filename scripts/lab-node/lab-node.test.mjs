import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const shellScripts = [
  "common.sh",
  "bootstrap.sh",
  "start.sh",
  "stop.sh",
  "restart-node.sh",
  "status.sh",
  "smoke.sh",
];

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
});

test("bootstrap initializes only after dependencies and builds exist", () => {
  const bootstrap = readFileSync(join(directory, "bootstrap.sh"), "utf8");
  const installAt = bootstrap.indexOf('pnpm --dir "$LAB_REPO" install');
  const initializeAt = bootstrap.indexOf('migrate.mjs" initialize');
  assert.ok(installAt >= 0 && initializeAt > installAt);
  assert.doesNotMatch(bootstrap, /flock -u 9|exec 9>&-/);

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
