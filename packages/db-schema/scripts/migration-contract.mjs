import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LEDGER_TABLE = "schema_migrations";
export const MIGRATION_LOCK_NAMESPACE = 260719;
export const MIGRATION_LOCK_ID = 1;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const migrationDirectory = resolve(packageRoot, "sql/migrations");
export const migrationManifestPath = resolve(packageRoot, "migration-manifest.json");
export const canonicalSchemaPath = resolve(packageRoot, "sql/schema.sql");
/**
 * **워커의** 배포 설정 파일 경로 — `.env.soul-server-ts`.
 *
 * 여기서 `HANIEL_SERVICE_ENV_FILE` 을 보면 안 된다. 그 변수는 "지금 릴리스 중인
 * 서비스"를 가리키는데, 워커 설정을 원하는 호출자에게 그것을 주면 orch 를
 * 배포하는 동안 orch 의 env 를 워커 것인 양 건네게 된다. 실제로 그렇게 해서
 * release health 가 MCP_ENABLED 를 잃고 HOST/PORT/AUTH_BEARER_TOKEN 까지
 * orch 값으로 덮인 적이 있다. 배포 중인 서비스의 설정이 필요하면
 * `releaseServiceEnvironmentPath` 를 쓴다.
 */
export function deploymentEnvironmentPath(env = process.env, cwd = process.cwd()) {
  const serviceCwd = env.HANIEL_SERVICE_CWD?.trim();
  return resolve(serviceCwd || cwd, ".env.soul-server-ts");
}

/**
 * **지금 릴리스 중인 서비스의** 설정 파일 경로.
 *
 * Haniel 은 그 서비스의 `release_env_file` 을 0600 임시 스냅샷으로 복사한 뒤
 * `HANIEL_SERVICE_ENV_FILE` 에 **경로만** 넘긴다. 값은 자식 env 에 합쳐지지 않고
 * `DATABASE_URL`·`PG*` 는 오히려 제거되므로, 이 파일을 읽지 않으면 배포 대상
 * 서비스의 설정에 닿을 방법이 없다.
 *
 * 마이그레이션·릴리스 도구 전용이다. 넘어오지 않으면 워커 경로로 돌아간다.
 */
export function releaseServiceEnvironmentPath(env = process.env, cwd = process.cwd()) {
  const serviceEnvFile = env.HANIEL_SERVICE_ENV_FILE?.trim();
  if (serviceEnvFile) {
    const serviceCwd = env.HANIEL_SERVICE_CWD?.trim();
    return resolve(serviceCwd || cwd, serviceEnvFile);
  }
  return deploymentEnvironmentPath(env, cwd);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function migrationSha256(sql) {
  return sha256(sql.replace(/\r\n?/g, "\n"));
}

/**
 * 마이그레이션·릴리스 도구가 쓸 데이터베이스 접속 문자열.
 *
 * `MIGRATION_DATABASE_URL`이 있으면 그것을 먼저 쓴다. 런타임 역할과 DDL 역할을
 * 분리한 배포에서 쓰라고 있는 자리다 — 런타임 역할에 CREATE 권한을 주지 않고도
 * 마이그레이션만 별도 자격증명으로 돌릴 수 있다. 없으면 기존대로 `DATABASE_URL`.
 *
 * 비어 있거나 공백뿐이면 "주지 않은 것"으로 본다. 아래 검증이 이미 그 규칙이라
 * 두 변수에 같은 규칙을 적용한다.
 */
export function readDatabaseUrl(env = process.env) {
  const value = env.MIGRATION_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required");
  if (!value.startsWith("postgres://") && !value.startsWith("postgresql://")) {
    throw new Error("DATABASE_URL must be postgres:// or postgresql://");
  }
  return value;
}

export function readReleaseId(env = process.env, { required = true } = {}) {
  const value = (env.HANIEL_RELEASE_ID ?? env.SOULSTREAM_RELEASE_ID)?.trim();
  if (!value && required) {
    throw new Error("HANIEL_RELEASE_ID or SOULSTREAM_RELEASE_ID is required");
  }
  return value ?? null;
}

export async function loadMigrationManifest() {
  const parsed = JSON.parse(await readFile(migrationManifestPath, "utf8"));
  if (parsed?.schema_version !== "soulstream.migrations.v1") {
    throw new Error("migration manifest schema must be soulstream.migrations.v1");
  }
  if (!Array.isArray(parsed.migrations) || parsed.migrations.length === 0) {
    throw new Error("migration manifest must contain migrations");
  }

  const files = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const ids = parsed.migrations.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate migration ID");
  if (JSON.stringify(ids) !== JSON.stringify([...ids].sort())) {
    throw new Error("migration manifest order must be lexical by full filename");
  }
  if (JSON.stringify(ids) !== JSON.stringify(files)) {
    throw new Error("migration manifest must list every SQL file exactly once");
  }

  const migrations = [];
  for (const [ordinal, entry] of parsed.migrations.entries()) {
    if (!/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(entry.id)) {
      throw new Error(`invalid full-filename migration ID: ${entry.id}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`invalid migration checksum: ${entry.id}`);
    }
    const path = resolve(migrationDirectory, entry.id);
    const sql = await readFile(path, "utf8");
    const actual = migrationSha256(sql);
    if (actual !== entry.sha256) {
      throw new Error(
        `migration checksum differs for ${entry.id}: expected ${entry.sha256}, got ${actual}`,
      );
    }
    migrations.push({ ...entry, ordinal: ordinal + 1, path, sql });
  }
  return migrations;
}

export function validateLedger(migrations, rows) {
  if (!Array.isArray(rows)) throw new Error("migration ledger must be an array");
  if (rows.length > migrations.length) throw new Error("migration ledger is longer than manifest");

  for (const [index, row] of rows.entries()) {
    const expected = migrations[index];
    const ordinal = Number(row.ordinal);
    if (row.migration_id !== expected.id || ordinal !== expected.ordinal) {
      throw new Error(
        `migration ledger order differs at ordinal ${index + 1}: ${row.migration_id}`,
      );
    }
    if (row.checksum !== expected.sha256) {
      throw new Error(`applied migration checksum differs: ${row.migration_id}`);
    }
  }
  return migrations.slice(rows.length);
}

export function classifySchemaState(shape) {
  const table = (kind) => kind === "r" || kind === "p";
  if (
    !shape.sessions
    && !shape.tasks
    && !shape.taskSections
    && !shape.runbooks
    && !shape.runbookItems
    && !shape.taskItems
    && !shape.taskOperations
    && !shape.runbookOperations
  ) {
    return "empty";
  }
  if (
    table(shape.tasks)
    && table(shape.taskSections)
    && shape.runbooks === "v"
    && shape.runbookItems === "v"
    && table(shape.taskItems)
    && table(shape.taskOperations)
    && shape.runbookOperations === "v"
    && shape.taskItemsHasSection
    && !shape.taskItemsHasParent
  ) {
    return "current";
  }
  if (
    !shape.tasks
    && table(shape.runbooks)
    && table(shape.runbookItems)
    && table(shape.runbookOperations)
    && table(shape.taskItems)
    && shape.taskItemsHasParent
    && !shape.taskItemsHasSection
  ) {
    return "legacy_pre_041";
  }
  if (
    !shape.tasks
    && table(shape.runbooks)
    && table(shape.runbookItems)
    && table(shape.runbookOperations)
    && !shape.taskItems
    && !shape.taskOperations
  ) {
    return "legacy_post_041";
  }
  throw new Error(`ambiguous database schema state: ${JSON.stringify(shape)}`);
}

export function buildMigrationPlan(migrations, ledger, shape) {
  const state = classifySchemaState(shape);
  const pendingFromLedger = validateLedger(migrations, ledger);
  const taskBaselineCount = migrations.findIndex(
    (item) => item.id === "042_runbook_to_task.sql",
  ) + 1;
  if (taskBaselineCount === 0) throw new Error("current schema bootstrap boundary missing");
  if (ledger.length > 0) {
    if (ledger.length < taskBaselineCount) {
      throw new Error("partial pre-baseline migration ledger is not a supported state");
    }
    if (pendingFromLedger.length === 0 && state !== "current") {
      throw new Error(`complete migration ledger conflicts with ${state} schema`);
    }
    return { state, bootstrap: [], pending: pendingFromLedger };
  }

  let bootstrapCount = 0;
  if (state === "current") {
    if (shape.deliveryAttemptTerminologyCurrent) {
      bootstrapCount = migrations.findIndex(
        (item) => item.id === "086_delivery_attempt_terminology.sql",
      ) + 1;
      if (bootstrapCount === 0) {
        throw new Error("delivery attempt terminology bootstrap boundary missing");
      }
    } else {
      bootstrapCount = taskBaselineCount;
    }
  }
  if (state === "legacy_pre_041") {
    bootstrapCount = migrations.findIndex((item) => item.id === "041_retire_task_tree.sql");
  }
  if (state === "legacy_post_041") {
    bootstrapCount = migrations.findIndex((item) => item.id === "042_runbook_to_task.sql");
  }
  if (bootstrapCount < 0) throw new Error(`bootstrap boundary missing for ${state}`);
  return {
    state,
    bootstrap: migrations.slice(0, bootstrapCount),
    pending: migrations.slice(bootstrapCount),
  };
}
