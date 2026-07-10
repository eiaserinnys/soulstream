import { describe, expect, it, vi } from "vitest";

import {
  AdminUsersRouteError,
  createLiveAdminUsersRepository,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  readonly text: string;
  readonly values: unknown[];
};

const createdAt = new Date("2026-07-10T00:00:00.000Z");

const userRow = {
  email: "user@example.com",
  display_name: "User",
  is_admin: false,
  allowed_folder_ids: ["folder-a"],
  created_at: createdAt,
  created_by: "admin@example.com",
};

describe("live admin users repository", () => {
  it("lists and resolves the Python users table projection", async () => {
    const harness = createSqlHarness([[userRow], [userRow]]);
    const repository = createLiveAdminUsersRepository({
      sqlResolver: resolverFor(harness.sql),
    });

    await expect(repository.listUsers()).resolves.toEqual([{
      email: "user@example.com",
      displayName: "User",
      isAdmin: false,
      allowedFolderIds: ["folder-a"],
      createdAt: "2026-07-10T00:00:00.000Z",
      createdBy: "admin@example.com",
    }]);
    await expect(repository.findUserByEmail(" User@Example.COM ")).resolves.toEqual({
      email: "user@example.com",
      isAdmin: false,
      allowedFolderIds: ["folder-a"],
    });

    expect(normalizeSql(harness.calls[0]?.text)).toContain(
      "SELECT email, display_name, is_admin, allowed_folder_ids, created_at, created_by FROM users ORDER BY email",
    );
    expect(normalizeSql(harness.calls[1]?.text)).toContain(
      "FROM users WHERE email = ? LIMIT 1",
    );
    expect(harness.calls[1]?.values).toEqual(["user@example.com"]);
  });

  it("creates a normalized user with the Python INSERT and RETURNING contract", async () => {
    const harness = createSqlHarness([[userRow]]);
    const repository = createLiveAdminUsersRepository({
      sqlResolver: resolverFor(harness.sql),
    });

    await expect(repository.createUser({
      email: " User@Example.COM ",
      displayName: "  User  ",
      isAdmin: false,
      allowedFolderIds: [" folder-a ", "folder-a", ""],
      createdBy: " Admin@Example.COM ",
    })).resolves.toMatchObject({ email: "user@example.com" });

    const sql = normalizeSql(harness.calls[0]?.text);
    expect(sql).toContain(
      "INSERT INTO users (email, display_name, is_admin, allowed_folder_ids, created_by)",
    );
    expect(sql).toContain("VALUES ( ?, ?, ?, ?::TEXT[], ? )");
    expect(sql).toContain(
      "RETURNING email, display_name, is_admin, allowed_folder_ids, created_at, created_by",
    );
    expect(harness.calls[0]?.values).toEqual([
      "user@example.com",
      "User",
      false,
      ["folder-a"],
      "admin@example.com",
    ]);
  });

  it("maps Postgres duplicate email to the Python validation error", async () => {
    const error = Object.assign(new Error("duplicate key"), { code: "23505" });
    const sql = vi.fn(async () => {
      throw error;
    }) as unknown as LivePostgresSql;
    const repository = createLiveAdminUsersRepository({
      sqlResolver: resolverFor(sql),
    });

    await expect(repository.createUser({
      email: "user@example.com",
      isAdmin: false,
      allowedFolderIds: [],
      createdBy: "admin@example.com",
    })).rejects.toEqual(
      expect.objectContaining({
        name: "AdminUsersRouteError",
        code: "USER_VALIDATION",
        message: "User already exists",
        statusCode: 400,
      }),
    );
  });

  it("updates only supplied fields while preserving the existing Python row", async () => {
    const updatedRow = {
      ...userRow,
      display_name: null,
      is_admin: false,
      allowed_folder_ids: [],
    };
    const harness = createSqlHarness([[userRow], [updatedRow]]);
    const repository = createLiveAdminUsersRepository({
      sqlResolver: resolverFor(harness.sql),
    });

    await expect(repository.updateUser("user@example.com", {
      displayName: "   ",
      isAdmin: null,
      allowedFolderIds: null,
    })).resolves.toMatchObject({
      displayName: null,
      isAdmin: false,
      allowedFolderIds: [],
    });

    expect(normalizeSql(harness.calls[1]?.text)).toContain(
      "UPDATE users SET display_name = ?, is_admin = ?, allowed_folder_ids = ?::TEXT[] WHERE email = ? RETURNING",
    );
    expect(harness.calls[1]?.values).toEqual([
      null,
      false,
      [],
      "user@example.com",
    ]);
  });

  it("maps missing update and delete targets to Python 404 errors", async () => {
    const updateHarness = createSqlHarness([[]]);
    const updateRepository = createLiveAdminUsersRepository({
      sqlResolver: resolverFor(updateHarness.sql),
    });
    await expect(
      updateRepository.updateUser("missing@example.com", { displayName: "Missing" }),
    ).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
      message: "User not found",
      statusCode: 404,
    });

    const deleteHarness = createSqlHarness([[]]);
    const deleteRepository = createLiveAdminUsersRepository({
      sqlResolver: resolverFor(deleteHarness.sql),
    });
    await expect(deleteRepository.deleteUser("missing@example.com")).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
      message: "User not found",
      statusCode: 404,
    });
    expect(normalizeSql(deleteHarness.calls[0]?.text)).toContain(
      "DELETE FROM users WHERE email = ? RETURNING email",
    );
  });

  it("checks whether another admin remains with the Python exclusion query", async () => {
    const harness = createSqlHarness([[{ count: "1" }], [{ count: "0" }]]);
    const repository = createLiveAdminUsersRepository({
      sqlResolver: resolverFor(harness.sql),
    });

    await expect(repository.canRemoveAdmin("admin@example.com")).resolves.toBe(true);
    await expect(repository.canRemoveAdmin("admin@example.com")).resolves.toBe(false);
    expect(normalizeSql(harness.calls[0]?.text)).toContain(
      "SELECT COUNT(*) AS count FROM users WHERE is_admin = TRUE AND email <> ?",
    );
    expect(harness.calls[0]?.values).toEqual(["admin@example.com"]);
  });
});

function createSqlHarness(results: readonly (readonly Record<string, unknown>[])[]) {
  const calls: SqlCall[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return results[calls.length - 1] ?? [];
  }) as unknown as LivePostgresSql;
  return { sql, calls };
}

function resolverFor(sql: LivePostgresSql) {
  return {
    resolveSql: vi.fn(async () => sql),
    close: vi.fn(async () => undefined),
  };
}

function normalizeSql(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

expect(AdminUsersRouteError).toBeDefined();
