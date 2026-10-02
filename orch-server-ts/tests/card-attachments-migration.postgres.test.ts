import {expect,it} from "vitest";
import {createPagePostgresHarness} from "./page/page_postgres_harness.js";
// @ts-expect-error JavaScript operations boundary (same as r2-settings integration).
import {loadMigrationManifest} from "../../packages/db-schema/scripts/migration-contract.mjs";
// Same disposable, empty test database as card workflow integration tests.
it("official attachments migration preserves old cards and defaults new cards to []",async()=>{
 const migration=(await loadMigrationManifest()).find((m:{id:string;sql:string})=>m.id==='114_card_attachments.sql')!;
 const h=await createPagePostgresHarness();
 try {
  await h.sql`ALTER TABLE cards DROP COLUMN attachments`;
  await h.sql`INSERT INTO folders(id,name) VALUES ('f','test')`;
  await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request) VALUES ('old','f','a','旧','原文')`;
  await h.sql.unsafe(migration.sql);
  await h.sql`INSERT INTO cards(id,folder_id,position_key,title) VALUES ('new','f','b','新')`;
  const rows=await h.sql`SELECT id,request,attachments FROM cards ORDER BY id`;
  expect(rows.map(row=>row.attachments)).toEqual([[],[]]);expect(rows.find(row=>row.id==='old')?.request).toBe('原文');
  await expect(h.sql`UPDATE cards SET attachments=NULL WHERE id='new'`).rejects.toMatchObject({code:'23502'});
 }finally{await h.cleanup();}
},60000);
