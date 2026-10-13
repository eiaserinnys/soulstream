import { afterEach, expect, it, vi } from "vitest";
import pino from "pino";
import { PersistentReportHostClient } from "../../src/control_plane/persistent_report_host_client.js";

afterEach(()=>vi.unstubAllGlobals());
it('passes the entry opaquely and returns stored updated_at strings unchanged',async()=>{
  const fetch=vi.fn(async()=>new Response(JSON.stringify({ok:true,changed:true,entries:[{key:'r1',title:'보고'}],persistent_report:[{key:'r1',updated_at:'2026-10-13T02:00:00.000Z'}]}),{status:200}));
  vi.stubGlobal('fetch',fetch);
  const client=new PersistentReportHostClient({orch:{baseUrl:'https://orch.example',headers:{authorization:'Bearer test-service'}},logger:pino({level:'silent'})});
  const entry={key:'r1',card_numbers:[270],question_id:'q1'};
  const result=await client.put('pas',entry);
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).args).toEqual(['pas',entry]);
  expect(result).toMatchObject({persistent_report:[{updated_at:'2026-10-13T02:00:00.000Z'}]});
});
