import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationPlan, loadMigrationManifest } from '../../packages/db-schema/scripts/migration-contract.mjs';
const migrations=await loadMigrationManifest();
const folder={sessions:'r',folders:'r',folderOperations:'r'};
const before={...folder,checklistSections:'r',checklistItems:'r',cards:'r'}; // Existing unrelated uuid knowledge table is not the new shape.
const after={...folder,cards:'r',cardReports:'r',cardQuestions:'r',cardsHaveFolderRequest:true,sessionsHaveCard:true};
test('pre-card databases with no ledger bootstrap only through 108 and apply 109',()=>{
 const plan=buildMigrationPlan(migrations,[],before);
 assert.equal(plan.state,'pre_cards');assert.equal(plan.bootstrap.at(-1).id,'108_unify_folders.sql');
 assert.deepEqual(plan.pending.map(m=>m.id),['109_cards.sql']);
});
test('fresh cards schema bootstraps through 109 without replaying destructive migration',()=>{
 const plan=buildMigrationPlan(migrations,[],after);
 assert.equal(plan.state,'current');assert.equal(plan.bootstrap.at(-1).id,'109_cards.sql');assert.deepEqual(plan.pending,[]);
});
test('ledger through 108 applies 109 and a partial cards shape is rejected',()=>{
 const ledger=migrations.slice(0,-1).map((m,i)=>({migration_id:m.id,checksum:m.sha256,ordinal:i+1}));
 assert.deepEqual(buildMigrationPlan(migrations,ledger,before).pending.map(m=>m.id),['109_cards.sql']);
 assert.throws(()=>buildMigrationPlan(migrations,[],{...after,cardReports:null}),/ambiguous/);
});
