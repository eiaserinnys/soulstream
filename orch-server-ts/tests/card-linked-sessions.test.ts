import { describe, expect, it } from "vitest";
import { CardRepositoryRead } from "../src/cards/control_plane/card_repository_read.js";
import type { SqlClient } from "../src/cards/control_plane/card_types.js";
import { serializeCardRow } from "../src/folders/folder_contracts.js";
describe("card linked session response",()=>{
 it("selects ancestry and activity timestamps and serializes camelCase",async()=>{
  let query="";let params:unknown[]=[];
  const row={session_id:"child",caller_session_id:"parent",updated_at:new Date("2026-09-30T00:00:00Z")};
  const sql=(async(parts:TemplateStringsArray,...values:unknown[])=>{query=parts.join("?");params=values;return [row];}) as unknown as SqlClient;
  const sessions=await new CardRepositoryRead(sql).listSessions("c");
  const projection=query.split("FROM")[0];
  expect(projection).toMatch(/\bcaller_session_id\b/);expect(projection).toMatch(/\bupdated_at\b/);
  expect(params).toEqual(["c"]);
  expect(sessions).toHaveLength(1);
  expect(serializeCardRow(sessions[0]!)).toEqual({sessionId:"child",callerSessionId:"parent",updatedAt:"2026-09-30T00:00:00.000Z"});
 });
});
