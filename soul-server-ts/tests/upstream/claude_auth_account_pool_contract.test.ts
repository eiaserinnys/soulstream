import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { CONTROL_COMMAND_TYPES } from "@soulstream/wire-schema";

type SchemaNode = {
  anyOf?: SchemaNode[];
  $ref?: string;
  const?: string;
  enum?: unknown[];
  format?: string;
  items?: SchemaNode;
  maximum?: number;
  minimum?: number;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  type?: string | string[];
};

type UpstreamSchema = {
  $defs: Record<string, SchemaNode>;
  oneOf: SchemaNode[];
  "x-soulstream-control-command-types": string[];
};

const schemaPath = resolve(
  import.meta.dirname,
  "../../../packages/wire-schema/src/upstream.schema.json",
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as UpstreamSchema;

const commandDefs = [
  ["ClaudeAuthAccountsList", "claude_auth_accounts_list", ["type"], "ClaudeAccountList"],
  ["ClaudeAuthAccountUpdate", "claude_auth_account_update", ["type", "account_id"], "ClaudeAccountList"],
  ["ClaudeAuthAccountDelete", "claude_auth_account_delete", ["type", "account_id"], "ClaudeAccountDeleteResult"],
  ["ClaudeAuthLoginStart", "claude_auth_login_start", ["type"], "ClaudeAuthLoginFlow"],
  ["ClaudeAuthLoginStatus", "claude_auth_login_status", ["type", "login_id"], "ClaudeAuthLoginFlow"],
  ["ClaudeAuthLoginSubmitCode", "claude_auth_login_submit_code", ["type", "login_id", "code"], "ClaudeAuthLoginFlow"],
  ["ClaudeAuthLoginCancel", "claude_auth_login_cancel", ["type", "login_id"], "ClaudeAuthLoginFlow"],
] as const;

describe("Claude account pool wire contract", () => {
  it("keeps all seven commands in the schema, generated type inventory, and root union", () => {
    const expectedTypes = commandDefs.map(([, type]) => type);
    const rootRefs = schema.oneOf.map(({ $ref }) => $ref);

    expect(schema["x-soulstream-control-command-types"]).toEqual(
      expect.arrayContaining(expectedTypes),
    );
    expect(CONTROL_COMMAND_TYPES).toEqual(expect.arrayContaining(expectedTypes));
    for (const [definitionName, type, requiredFields, dataDefinition] of commandDefs) {
      expect(schema.$defs[definitionName]?.properties?.type?.const).toBe(type);
      expect(rootRefs).toContain(`#/$defs/${definitionName}`);
      expect(schema.$defs[definitionName]?.required).toEqual(expect.arrayContaining(requiredFields));
      expect(schema.$defs[definitionName]?.properties?.data?.$ref)
        .toBe(`#/$defs/${dataDefinition}`);
      expect(schema.$defs[definitionName]?.properties?.error?.$ref)
        .toBe("#/$defs/ClaudeAuthError");
    }
  });

  it("defines account usage, pools, and account-list mode as the shared contract", () => {
    const accountList = schema.$defs.ClaudeAccountList;
    const account = schema.$defs.ClaudeAccount;
    const usageWindow = schema.$defs.ClaudeAccountUsageWindow;
    const pool = schema.$defs.ClaudeAccountPool;

    expect(accountList.properties?.mode?.enum).toEqual(["legacy", "pool"]);
    expect(Object.keys(accountList.properties ?? {}).sort()).toEqual([
      "accounts", "fable_pool", "mode", "pool",
    ]);
    expect(Object.keys(account.properties ?? {}).sort()).toEqual([
      "active_sessions", "auth_state", "blocked", "email", "enabled", "id",
      "observed_at", "plan", "priority", "usage",
    ]);
    expect(Object.keys(account.properties?.usage?.properties ?? {}).sort()).toEqual([
      "fable_weekly", "five_hour", "seven_day",
    ]);
    expect(account.properties?.auth_state?.enum).toEqual([
      "ok", "idle", "needs_relogin", "logging_in",
    ]);
    expect(usageWindow.properties?.used_percent).toMatchObject({
      type: "number",
      minimum: 0,
      maximum: 100,
    });
    expect(usageWindow.properties?.resets_at?.format).toBe("date-time");
    expect(pool.required).toEqual(expect.arrayContaining([
      "available_count",
      "total_count",
      "best_weekly_remaining_percent",
      "best_weekly_resets_at",
      "earliest_available_at",
    ]));
  });

  it("defines the LoginFlow state and error contracts", () => {
    const loginFlow = schema.$defs.ClaudeAuthLoginFlow;
    const loginError = schema.$defs.ClaudeAuthError;

    expect(loginFlow.properties?.state?.enum).toEqual([
      "requested",
      "url_ready",
      "code_submitted",
      "verifying",
      "done",
      "failed",
      "cancelled",
    ]);
    expect(loginFlow.required).toEqual([
      "login_id", "account_id", "state", "auth_url", "expires_at", "error",
    ]);
    expect(Object.keys(loginFlow.properties ?? {}).sort()).toEqual([
      "account_id", "auth_url", "error", "expires_at", "login_id", "state",
    ]);
    expect(loginFlow.properties?.auth_url?.type).toEqual(["string", "null"]);
    expect(loginFlow.properties?.error?.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ $ref: "#/$defs/ClaudeAuthError" }),
        expect.objectContaining({ type: "null" }),
      ]),
    );
    expect(loginError.required).toEqual(["code", "message"]);
    expect(loginError.properties?.existing_account_id?.type).toBe("string");
  });

  it("advertises the static account-pool capability as optional boolean", () => {
    expect(schema.$defs.NodeRegister.properties?.capabilities?.properties
      ?.claude_account_pool_v1).toMatchObject({ type: "boolean" });
  });
});
