import postgres from "postgres";

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 10_000;
const FRESH_INSTALL_COMMAND = "node packages/db-schema/scripts/migrate.mjs fresh-install";

/** A startup failure whose message already says what the operator should do. */
export class StartupPreflightError extends Error {
  override readonly name = "StartupPreflightError";
}

export type StartupPreflightSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<readonly Record<string, unknown>[]>;
  readonly end: (options?: { readonly timeout?: number }) => Promise<void>;
};

export type StartupPreflightOptions = {
  readonly timeoutMs?: number;
  /** Test seam: production opens one short-lived postgres.js connection. */
  readonly clientFactory?: (databaseUrl: string, connectTimeoutSeconds: number) => StartupPreflightSql;
};

/**
 * Proves the database is reachable and migrated before the orchestrator starts.
 * Only connection establishment is bounded; handover lock waits happen later.
 */
export async function checkDatabaseReady(
  databaseUrl: string,
  options: StartupPreflightOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const target = describeTarget(databaseUrl);
  const sql = (options.clientFactory ?? openClient)(databaseUrl, Math.max(1, Math.ceil(timeoutMs / 1_000)));
  let timer: NodeJS.Timeout | undefined;
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new StartupPreflightError(
        `데이터베이스(${target.address})에 ${Math.ceil(timeoutMs / 1_000)}초 안에 연결하지 못했습니다. `
        + "DATABASE_URL의 호스트와 포트가 맞는지, PostgreSQL이 떠 있는지 확인하세요.",
      )), timeoutMs);
    });
    const rows = await Promise.race([
      Promise.resolve(sql`SELECT to_regclass('schema_migrations') IS NOT NULL AS present`),
      timedOut,
    ]);
    if (rows[0]?.present !== true) {
      throw new StartupPreflightError(
        `데이터베이스(${target.address})에 schema_migrations 표가 없습니다. `
        + `먼저 \`${FRESH_INSTALL_COMMAND}\` 을 실행하세요.`,
      );
    }
  } catch (error) {
    if (error instanceof StartupPreflightError) throw error;
    throw new StartupPreflightError(
      `데이터베이스(${target.address})에 연결하지 못했습니다: ${target.scrub(causeText(error))}. `
      + "DATABASE_URL의 호스트, 포트, 계정이 맞는지, PostgreSQL이 떠 있는지 확인하세요.",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void sql.end({ timeout: 0 }).catch(() => undefined);
  }
}

function openClient(databaseUrl: string, connectTimeoutSeconds: number): StartupPreflightSql {
  return postgres(databaseUrl, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: connectTimeoutSeconds,
    onnotice: () => undefined,
  }) as unknown as StartupPreflightSql;
}

function causeText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  const message = error.message.length > 0 ? error.message : error.name;
  return typeof code === "string" && !message.includes(code) ? `${code} ${message}` : message;
}

function describeTarget(databaseUrl: string): { address: string; scrub: (text: string) => string } {
  let address = "DATABASE_URL";
  const secrets = [databaseUrl];
  try {
    const url = new URL(databaseUrl);
    address = `${url.hostname}:${url.port === "" ? "5432" : url.port}`;
    if (url.password !== "") secrets.push(url.password, decodeURIComponent(url.password));
  } catch {
    // An unparsable URL is reported without any part of it.
  }
  return {
    address,
    scrub: (text) => secrets.reduce((acc, secret) => acc.split(secret).join("***"), text),
  };
}
