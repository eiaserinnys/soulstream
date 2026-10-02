import { expect, it, vi } from "vitest";
import { cardOperationSchemas } from "../src/cards/card_operations.js";
import { CardOrchestrationWorkers } from "../src/cards/card_orchestration_workers.js";
import { createRecurringSession } from "../src/session/recurring_session_creation.js";

const attachments = [{nodeId:"node",path:"/incoming/upload/image.png",name:"image.png",mimeType:"image/png"}];
it("accepts structured card attachments without changing the request", () => {
  const input={folderId:"f",title:"제목",request:"사용자 원문",queue:false,idempotencyKey:"k",attachments};
  expect(cardOperationSchemas.create_card.strict().parse(input)).toEqual(input);
  expect(cardOperationSchemas.create_card.parse({...input,attachments:undefined}).attachments).toEqual([]);
});
it("forwards attachments to the actual create_session command", async () => {
  const createSession=vi.fn(()=>({node:{nodeId:"node"},modelPresetId:"sol"}));
  await createRecurringSession({router:{createSession,waitForCreatedSession:async()=>false} as any,bridge:{sendPendingCommand:async()=>({status:"ok"})} as any},
    {sessionId:"81d61f13-b99b-4c58-9830-55487618e4dc",prompt:"原文",nodeId:"node",agentId:"roselin",modelPreset:"sol",folderId:"f",callerInfo:{},attachmentPaths:attachments.map(a=>a.path)});
  expect(createSession).toHaveBeenCalledWith(expect.objectContaining({attachment_paths:attachments.map(a=>a.path)}),expect.anything());
});
it.each(["existingSession","resume"])("passes structured attachments when %s is resumed",async flag=>{
 const sendMessage=vi.fn(),launchWorker=vi.fn();
 const d={session_id:"s",run_id:"r",card_id:"c",node_id:"node",launch_token:"t",state:"pending",input:{[flag]:true,prompt:"要求",attachments}};
 await new CardOrchestrationWorkers({repository:{pendingWorkers:async()=>[d],claimWorker:async()=>true,workerObserved:async()=>false} as any,cards:vi.fn(),sendMessage,launchWorker,warn:vi.fn()}).reconcile();
 expect(sendMessage).toHaveBeenCalledWith("s","要求",expect.anything(),undefined,attachments);
 expect(launchWorker).not.toHaveBeenCalled();
});

import {cardAttachmentPaths} from "../src/cards/card_attachment_paths.js";
it("stops foreign-node attachments and preserves attachment-free work",()=>{
 expect(cardAttachmentPaths([],"other")).toEqual([]);
 expect(()=>cardAttachmentPaths(attachments,"other")).toThrow(/노드.*다릅니다/);
 expect(cardAttachmentPaths(attachments,"node")).toEqual([attachments[0]!.path]);
});
