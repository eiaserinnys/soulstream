import { describe, expect, it } from "vitest";
import { buildPersistentReportContext } from "../../src/context/persistent_report_context.js";
import { buildUserMessageEvent } from "../../src/task/task_user_message_events.js";

describe('PAS report start and user-message contexts',()=>{
  it('carries the persisted current board including an empty board',()=>{
    expect(buildPersistentReportContext([])).toEqual({key:'persistent_report',label:'지금의 보고',content:'지금의 보고 (0장)\n[]'});
    const board=[{key:'latest',title:'지금의 결정',state:'answered',answer:'진행'}];
    expect(buildPersistentReportContext([{type:'persistent_generation',value:{number:2}},{type:'persistent_report',value:{entries:board}}]).content).toBe(`지금의 보고 (1장)\n${JSON.stringify(board)}`);
  });
  it('stores reply and visible context items on the ordinary user event without creating a report event',()=>{
    const context=[{key:'persistent_report_reply',content:{key:'latest',option:'진행'}},{key:'persistent_report_visible',content:{key:'latest',title:'지금의 결정'}}];
    expect(buildUserMessageEvent({text:'결정: 진행',contextItems:context})).toMatchObject({type:'user_message',context});
  });
});
