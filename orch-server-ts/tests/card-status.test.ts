import { expect, it } from "vitest";
import { cardOperationSchemas } from "../src/cards/card_operations.js";
it("accepts all card states and optional block/restart detail, but rejects invalid data",()=>{
 const input={expectedVersion:1,idempotencyKey:"status"};
 for(const status of ["todo","queued","blocked","running","review","on_hold","done","cancelled"])
  expect(cardOperationSchemas.set_card_status.parse({...input,status})).toMatchObject({status});
 expect(cardOperationSchemas.set_card_status.parse({...input,status:"awaiting_verification",
   wakeAt:"2026-11-12T09:00:00+09:00",waitingFor:"배포 뒤 확인"}))
   .toMatchObject({status:"awaiting_verification",wakeAt:"2026-11-12T09:00:00+09:00",waitingFor:"배포 뒤 확인"});
 expect(cardOperationSchemas.set_card_status.safeParse({...input,status:"archived"}).success).toBe(false);
 expect(cardOperationSchemas.set_card_status.safeParse({...input,status:"blocked",blockedKind:"manual"}).success).toBe(false);
 expect(cardOperationSchemas.set_card_status.safeParse({...input,status:"todo",expectedVersion:0}).success).toBe(false);
});
it("requires both verification wait fields for the wait state and forbids them elsewhere",()=>{
 const input={expectedVersion:1,idempotencyKey:"status"};
 for(const fields of [{},{wakeAt:"2026-11-12T09:00:00+09:00"},{waitingFor:"배포 뒤 확인"}])
  expect(cardOperationSchemas.set_card_status.safeParse({...input,status:"awaiting_verification",...fields}).success).toBe(false);
 for(const fields of [{wakeAt:"2026-11-12T09:00:00+09:00"},{waitingFor:"배포 뒤 확인"}])
  expect(cardOperationSchemas.set_card_status.safeParse({...input,status:"running",...fields}).success).toBe(false);
 expect(cardOperationSchemas.set_card_status.safeParse({...input,status:"awaiting_verification",
   wakeAt:"2026-11-12T09:00",waitingFor:"배포 뒤 확인"}).success).toBe(false);
 expect(cardOperationSchemas.set_card_status.safeParse({...input,status:"awaiting_verification",
   wakeAt:"2026-11-12T09:00:00+09:00",waitingFor:" "}).success).toBe(false);
});
