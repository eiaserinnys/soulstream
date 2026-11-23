import { afterEach, expect, it } from "vitest";
import { useCardStore } from "./card-store";
import type { CardDetail, CardRow } from "./card-types";

afterEach(()=>useCardStore.getState().reset());

it("copies each map at most once per batch while retaining version and detail semantics",()=>{
  const row=(id:string,version:number,title=id)=>({id,version,title,folderId:"folder",status:"running"}) as CardRow;
  const a=row("a",1),b=row("b",2),old=row("old",5);
  let rowCopies=0,detailCopies=0;
  const byId=new Proxy({a,b,old},{ownKeys(target){rowCopies++;return Reflect.ownKeys(target);}});
  const details=new Proxy({a:{card:a,reports:[],questions:[],sessions:[]} as CardDetail,b:{card:b,reports:[],questions:[],sessions:[]} as CardDetail},
    {ownKeys(target){detailCopies++;return Reflect.ownKeys(target);}});
  useCardStore.setState({byId,details});
  const updatedA={...row("a",1,"새 활동"),latestActivity:{kind:"instruction",format:"markdown",body:"변경",createdAt:""}} as CardRow;
  const updatedB=row("b",3);
  useCardStore.getState().putCards([updatedA,updatedB,row("old",4)]);
  expect(rowCopies).toBe(1);expect(detailCopies).toBe(1);
  expect(useCardStore.getState().byId).toMatchObject({a:updatedA,b:updatedB,old});
  expect(useCardStore.getState().details.a.card).toBe(updatedA);
  expect(useCardStore.getState().details.b.card).toBe(updatedB);
});
