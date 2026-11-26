import { describe, expect, it, vi } from "vitest";

import {
  StartupPreflightError,
  checkDatabaseReady,
  type StartupPreflightSql,
} from "../src/runtime/startup_preflight.js";
import { reportStartupFailure } from "../src/production_main.js";

const PASSWORD = "s3cr3t-pw";
const DATABASE_URL = `postgres://soul:${PASSWORD}@db.example.internal:6543/soulstream`;

function fakeSql(query: () => Promise<readonly Record<string, unknown>[]>): StartupPreflightSql {
  const sql = (async () => await query()) as unknown as StartupPreflightSql;
  Object.assign(sql, { end: vi.fn(async () => undefined) });
  return sql;
}

describe("orch 시작 때 DB 점검", () => {
  it("schema_migrations 가 없는 DB 는 fresh-install 안내와 함께 StartupPreflightError 로 끝난다", async () => {
    const sql = fakeSql(async () => [{ present: false }]);

    const failure = await checkDatabaseReady(DATABASE_URL, { clientFactory: () => sql })
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(StartupPreflightError);
    const message = (failure as Error).message;
    expect(message).toContain("migrate.mjs fresh-install");
    expect(message).not.toContain(PASSWORD);
    expect(sql.end).toHaveBeenCalled();
  });

  it("마이그레이션 표가 있으면 통과하고 연결을 닫는다", async () => {
    const sql = fakeSql(async () => [{ present: true }]);

    await expect(checkDatabaseReady(DATABASE_URL, { clientFactory: () => sql })).resolves.toBeUndefined();
    expect(sql.end).toHaveBeenCalled();
  });

  it("연결 수립이 제한 시간을 넘기면 호스트와 포트가 든 안내로 끝나고 비밀번호는 없다", async () => {
    const sql = fakeSql(() => new Promise(() => undefined));

    const failure = await checkDatabaseReady(DATABASE_URL, { clientFactory: () => sql, timeoutMs: 30 })
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(StartupPreflightError);
    const message = (failure as Error).message;
    expect(message).toContain("db.example.internal");
    expect(message).toContain("6543");
    expect(message).not.toContain(PASSWORD);
  });

  it("연결이 거절되면 원인을 싣되 오류 문장 속 비밀번호는 가린다", async () => {
    const sql = fakeSql(async () => {
      throw Object.assign(new Error(`connect ECONNREFUSED db.example.internal:6543 (${PASSWORD})`), { code: "ECONNREFUSED" });
    });

    const failure = await checkDatabaseReady(DATABASE_URL, { clientFactory: () => sql })
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(StartupPreflightError);
    const message = (failure as Error).message;
    expect(message).toContain("ECONNREFUSED");
    expect(message).toContain("db.example.internal:6543");
    expect(message).not.toContain(PASSWORD);
  });

  it("점검 실패는 안내 한 줄을 찍고 0이 아닌 종료 코드로 끝난다", () => {
    const logger = { error: vi.fn() };
    const exit = vi.fn();

    reportStartupFailure(new StartupPreflightError("DB 안내 문장"), { logger, exit });

    expect(logger.error).toHaveBeenCalledWith("DB 안내 문장");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
