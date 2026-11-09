import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  resolveExecutionSecurityDecision,
  type ExecutionSecurityPolicyPorts,
} from "../../soul-server-ts/src/security/session_execution_policy.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import {
  SessionReadRepository,
  type HostSessionExecutionChain,
} from "../src/control_plane/repositories/session_read_repository.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

// Real PostgreSQL: the recursive ancestry query must return the shape the
// execution-security decision consumes, including where the chain stops.
describe("session caller chain on real PostgreSQL", () => {
  let h: FullSchemaPostgresHarness;
  let repository: SessionReadRepository;

  beforeAll(async () => {
    h = await createFullSchemaPostgresHarness();
    // The runtime hands this repository the board-yjs adapter, cast to the driver's type.
    repository = new SessionReadRepository(createFolderContentSqlAdapter(h.sql as unknown as LivePostgresSql) as unknown as SqlClient);
    await h.sql`INSERT INTO sessions(session_id,status,caller_session_id,model_preset,model,agent_id) VALUES
      ('lone-session','running',NULL,NULL,NULL,NULL),
      ('leaf-session','running','middle-session','claude-opus',NULL,'seosoyoung'),
      ('middle-session','running','top-session','claude-opus','opus','roselin'),
      ('top-session','completed',NULL,NULL,NULL,'seosoyoung'),
      ('cycle-a','running','cycle-b','claude-opus',NULL,NULL),
      ('cycle-b','running','cycle-a','claude-opus',NULL,NULL),
      ('orphan-session','running','ghost-session',NULL,NULL,NULL)`;
    await h.sql`INSERT INTO sessions(session_id,status,caller_session_id,model_preset)
      SELECT 'depth-' || i, 'running',
             CASE WHEN i < 66 THEN 'depth-' || (i + 1) ELSE NULL END,
             'claude-opus'
      FROM generate_series(0, 66) AS i`;
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  it("returns only the root for a session without a caller", async () => {
    await expect(repository.getSessionCallerChain("lone-session")).resolves.toEqual({
      root: {
        session_id: "lone-session",
        caller_session_id: null,
        model_preset: null,
        model: null,
        agent_id: null,
      },
      ancestors: [],
    });
  });

  it("returns the ancestors nearest first and ends on the root of the chain", async () => {
    const chain = await repository.getSessionCallerChain("leaf-session");

    expect(chain.root).toEqual({
      session_id: "leaf-session",
      caller_session_id: "middle-session",
      model_preset: "claude-opus",
      model: null,
      agent_id: "seosoyoung",
    });
    expect(chain.ancestors.map((row) => row.session_id)).toEqual(["middle-session", "top-session"]);
    expect(chain.ancestors[0]).toEqual({
      session_id: "middle-session",
      caller_session_id: "top-session",
      model_preset: "claude-opus",
      model: "opus",
      agent_id: "roselin",
    });
    expect(chain.ancestors.at(-1)?.caller_session_id).toBeNull();
  });

  it("stops on a cycle and leaves the last caller pointing at a session already seen", async () => {
    const chain = await repository.getSessionCallerChain("cycle-a");

    expect(chain.root?.session_id).toBe("cycle-a");
    expect(chain.ancestors.map((row) => row.session_id)).toEqual(["cycle-b"]);
    expect(chain.ancestors.at(-1)?.caller_session_id).toBe("cycle-a");
  });

  it("stops when the caller row is missing and leaves a non-null caller", async () => {
    const chain = await repository.getSessionCallerChain("orphan-session");

    expect(chain.root?.session_id).toBe("orphan-session");
    expect(chain.ancestors).toEqual([]);
    expect(chain.root?.caller_session_id).toBe("ghost-session");
  });

  it("returns the root and 64 ancestors for a chain longer than the depth cap", async () => {
    const chain = await repository.getSessionCallerChain("depth-0");

    expect(chain.root?.session_id).toBe("depth-0");
    expect(chain.ancestors.map((row) => row.session_id)).toEqual(
      Array.from({ length: 64 }, (_, index) => `depth-${index + 1}`),
    );
    expect(chain.ancestors.at(-1)?.caller_session_id).toBe("depth-65");
  });

  it("returns a null root for an unknown session", async () => {
    await expect(repository.getSessionCallerChain("no-such-session")).resolves.toEqual({
      root: null,
      ancestors: [],
    });
  });

  it("feeds the stored chain into the execution security decision", async () => {
    const decide = (sessionId: string, chain: HostSessionExecutionChain) =>
      resolveExecutionSecurityDecision(sessionId, "claude-opus", {
        platform: "linux",
        readSession: async () => chain,
        readNodePreset: (agentId) => (agentId === "seosoyoung" ? "claude-opus" : null),
        isTrustedPreset: (presetId) => presetId === "claude-opus",
      } satisfies ExecutionSecurityPolicyPorts);

    await expect(
      decide("leaf-session", await repository.getSessionCallerChain("leaf-session")),
    ).resolves.toMatchObject({ tier: "full", reason: "trusted" });

    for (const sessionId of ["cycle-a", "orphan-session", "depth-0"]) {
      await expect(
        decide(sessionId, await repository.getSessionCallerChain(sessionId)),
      ).resolves.toMatchObject({ tier: "restricted", reason: "unresolved-ancestry" });
    }
  });
});
