import { expect, it } from "vitest";
import { cardOperationSchemas } from "../src/cards/card_operations.js";
it("accepts all card states and optional block/restart detail, but rejects invalid data",()=>{
 const input={expectedVersion:1,idempotencyKey:"status"};
 for(const status of ["todo","queued","blocked","running","review","done","cancelled"])
  expect(cardOperationSchemas.set_card_status.parse({...input,status})).toMatchObject({status});
 expect(cardOperationSchemas.set_card_status.safeParse({...input,status:"archived"}).success).toBe(false);
 expect(cardOperationSchemas.set_card_status.safeParse({...input,status:"blocked",blockedKind:"manual"}).success).toBe(false);
 expect(cardOperationSchemas.set_card_status.safeParse({...input,status:"todo",expectedVersion:0}).success).toBe(false);
});
