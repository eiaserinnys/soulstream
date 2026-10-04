/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDashboardStore, type SessionSummary } from "@seosoyoung/soul-ui";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardDetail } from "@seosoyoung/soul-ui/cards/card-types";
import { CardDetailPane } from "./CardDetailPane";

// Reuse the detail interaction tests' real root/store with only the ID provider mocked.
const lookup = vi.hoisted(() => ({sessions: [] as SessionSummary[], loading: false}));
vi.mock("@seosoyoung/soul-ui", async original => ({
  ...await original<typeof import("@seosoyoung/soul-ui")>(),
  useAuth: () => ({user:null}), useSessionListProvider: () => lookup,
}));
const session = (id:string):SessionSummary => ({agentSessionId:id,displayName:id,status:"completed",
  eventCount:1,nodeId:"eiaserinnys",agentId:"roselin",createdAt:"2026-10-01",updatedAt:"2026-10-01"});
const owner = session("owner"), child = {...session("child"),callerSessionId:"owner"};
const card = {id:"a",folderId:"f",title:"담당 대화 카드",request:"요청",brief:"",status:"running",
  blockedKind:null,version:1,createdAt:"2026-10-01",updatedAt:"2026-10-01",assigneeKind:"session",
  assigneeSessionId:"owner",nodeId:"eiaserinnys",assigneeAgentId:"roselin"} as CardDetail["card"];
let container:HTMLDivElement, root:Root;
const put = (value=card) => {
  const detail:CardDetail = {card:value,sessions:[{sessionId:"child",cardId:value.id,displayName:"child",
    nodeId:"eiaserinnys",agentId:"roselin",status:"completed",createdAt:"2026-10-01",updatedAt:"2026-10-01",callerSessionId:"owner"}],
    comments:[],reports:[],questions:[]};
  useCardStore.setState(state=>({byId:{...state.byId,[value.id]:value},details:{...state.details,[value.id]:detail}}));
};
const render = (open: (session:SessionSummary)=>void, id="a") => act(()=>root.render(
  <CardDetailPane cardId={id} folders={[]} onClose={()=>{}} onOpenSession={open}/>));
beforeEach(()=>{
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  lookup.sessions=[];lookup.loading=false;
  useDashboardStore.setState({catalog:null,drafts:{}});
  useCardStore.setState({loadCard:vi.fn().mockResolvedValue(undefined)}); put();
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(()=>root.unmount());container.remove();useCardStore.getState().reset();vi.restoreAllMocks();});

it("opens the catalog assignee once and preserves a manually selected linked session on updates",async()=>{
  useDashboardStore.setState({catalog:{sessionList:[owner,child]} as never});
  const open=vi.fn();await render(open);
  expect(open).toHaveBeenCalledTimes(1);expect(open).toHaveBeenCalledWith(owner,{source:'automatic'});
  await act(()=>container.querySelector<HTMLButtonElement>('[data-session-id="child"] button')!.click());
  expect(open).toHaveBeenLastCalledWith(child,{source:'user'});
  await act(()=>useDashboardStore.setState({catalog:{sessionList:[{...owner,eventCount:2},child]} as never}));
  await render(value=>open(value));
  expect(open).toHaveBeenCalledTimes(2);
});
it("waits for the existing targeted lookup when the assignee is absent from the catalog",async()=>{
  lookup.sessions=[child];lookup.loading=true;
  const open=vi.fn();await render(open);expect(open).not.toHaveBeenCalled();
  lookup.sessions=[child,owner];lookup.loading=false;await render(open);
  expect(open).toHaveBeenCalledTimes(1);expect(open).toHaveBeenCalledWith(owner,{source:'automatic'});
});
it.each([
  {assigneeKind:null,assigneeSessionId:null},
  {assigneeKind:"agent",assigneeSessionId:"owner"},
] as const)("keeps existing selection for a card without a session assignee ($assigneeKind)",async assignment=>{
  put({...card,...assignment});lookup.sessions=[owner,child];
  const open=vi.fn();await render(open);expect(open).not.toHaveBeenCalled();
});
it("opens B's assignee when navigating directly from card A to card B",async()=>{
  const second=session("second-owner");lookup.sessions=[owner,child,second];
  put({...card,id:"b",assigneeSessionId:second.agentSessionId});
  const open=vi.fn();await render(open);await render(open,"b");
  expect(open.mock.calls.map(([value])=>value.agentSessionId)).toEqual(["owner","second-owner"]);
});
