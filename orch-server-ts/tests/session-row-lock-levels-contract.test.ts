import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Card #1332. The card paths read sessions without a row lock, and the session row locks that
 * neither delete the row nor change session_id use FOR NO KEY UPDATE, so the KEY SHARE of a
 * foreign key check never queues behind them. The statements are read from the source so a
 * lock clause added back to one of them fails here.
 */
const source = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");

/** Every tagged-template SQL body of the file that reads from sessions. */
function sessionStatements(path: string): string[] {
  return [...source(path).matchAll(/`([^`]*)`/g)]
    .map((match) => match[1]!.replace(/\s+/g, " ").trim())
    .filter((text) => /\bFROM sessions\b/.test(text));
}

describe("session row lock levels", () => {
  it.each([
    ["cards/card_server_evidence_reader.ts", /^SELECT (card_id|session_id,status,termination_reason,termination_event_id) FROM sessions WHERE session_id=\$\{command.sessionId\}$/],
    ["cards/card_work_lifecycle.ts", /^SELECT session_id FROM sessions WHERE session_id=\$\{sessionId\} AND execution_registration_id=.*\)$/],
    ["cards/card_work_dispatch_service.ts", /^SELECT session_id FROM sessions WHERE session_id=\$\{ownerSessionId\} AND card_id=\$\{card.id\}$/],
  ])("%s reads sessions without a row lock", (path, pattern) => {
    const statements = sessionStatements(path);
    expect(statements.filter((text) => pattern.test(text)).length).toBeGreaterThan(0);
    for (const text of statements.filter((item) => pattern.test(item))) expect(text).not.toMatch(/FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)/);
    expect(statements.filter((text) => /FOR SHARE/.test(text))).toEqual([]);
  });

  it.each([
    ["node/event_ingress_repository.ts", /WHERE session_id = \? FOR NO KEY UPDATE$/],
    ["session/persistent_report_service.ts", /WHERE session_id=\? FOR NO KEY UPDATE$/],
    ["session/session_folder_move_repository.ts", /ORDER BY session_id FOR NO KEY UPDATE$/],
  ])("%s locks session rows with FOR NO KEY UPDATE", (path, pattern) => {
    const locks = sessionStatements(path).filter((text) => /FOR (NO KEY )?UPDATE/.test(text));
    expect(locks).toHaveLength(1);
    expect(locks[0]!.replace(/\$\{[^}]*\}/g, "?")).toMatch(pattern);
    expect(locks[0]).not.toMatch(/FOR UPDATE/);
  });

  it("keeps the card row lock of the folder move on FOR UPDATE", () => {
    expect(source("session/session_folder_move_repository.ts")).toMatch(/FROM cards WHERE assignee_session_id[^`]*ORDER BY id FOR UPDATE/);
  });
});
