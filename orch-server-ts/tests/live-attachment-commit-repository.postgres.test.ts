import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLiveAttachmentCommitRepository } from "../src/runtime/live_attachment_commit_repository.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

const describePostgres = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0
  ? describe
  : describe.skip;

// The commit service compares the stored registration with the requested one, so
// the scope must round-trip through the real driver as a JSON object. A unit test
// with a fake sql cannot see postgres.js re-encoding a pre-stringified value.
describePostgres("live attachment commit repository PostgreSQL contract", () => {
  let harness: PagePostgresHarness;
  let repository: ReturnType<typeof createLiveAttachmentCommitRepository>;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    repository = createLiveAttachmentCommitRepository(
      createLiveDbSqlResolver({ sql: harness.liveSql }),
    );
  }, 60_000);

  afterAll(async () => await harness?.cleanup());

  it("stores the registration scope as a JSON object and returns it unchanged", async () => {
    const scope = { type: "card" as const, id: "card-scope-1" };
    const inserted = await repository.insertOwnedPending({
      attachmentId: "scope-object",
      storageKey: "session-attachments/originals/scope-object",
      owner: { kind: "agent_session", key: "session-producer" },
      registration: {
        registrationScope: scope,
        sourceNodeId: "node-remote",
        sourceSessionId: "session-producer",
        outputCommandId: "execute:command-1",
      },
      originalName: "proof.png",
      mimeType: "image/png",
      byteSize: 191,
      location: { endpoint: "https://r2.example.test", bucket: "private-attachments" },
    });

    expect(inserted?.registration.registrationScope).toEqual(scope);
    const rows = await harness.sql<{ kind: string; scope_type: string; scope_id: string }[]>`
      SELECT jsonb_typeof(registration_scope) AS kind,
             registration_scope->>'type' AS scope_type,
             registration_scope->>'id' AS scope_id
      FROM file_assets WHERE id = 'scope-object'
    `;
    expect(rows[0]).toEqual({ kind: "object", scope_type: "card", scope_id: "card-scope-1" });
  });

  it("keeps a null registration scope as SQL NULL", async () => {
    await repository.insertOwnedPending({
      attachmentId: "scope-null",
      storageKey: "session-attachments/originals/scope-null",
      owner: { kind: "agent_session", key: "session-producer" },
      registration: {
        registrationScope: null,
        sourceNodeId: null,
        sourceSessionId: "session-producer",
        outputCommandId: null,
      },
      originalName: "plain.txt",
      mimeType: "text/plain",
      byteSize: 4,
      location: { endpoint: "https://r2.example.test", bucket: "private-attachments" },
    });

    const rows = await harness.sql<{ is_null: boolean }[]>`
      SELECT registration_scope IS NULL AS is_null FROM file_assets WHERE id = 'scope-null'
    `;
    expect(rows[0]?.is_null).toBe(true);
  });
});
