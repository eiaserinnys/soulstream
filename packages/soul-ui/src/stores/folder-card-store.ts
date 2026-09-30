import { useCardStore } from "../cards/card-store";
import { create } from "zustand";
import { cardRequest } from "../cards/card-api";
import type { CardRow } from "../cards/card-types";
export type FolderStatus = "open" | "completed";
export type FolderCompletionKind = "agent" | "user" | "llm";

export interface CardAssigneeFields {
  assigneeKind: "agent" | "human" | "session" | null;
  assigneeAgentId: string | null;
  assigneeSessionId: string | null;
  assigneeUserId: string | null;
}

export interface FolderRow {
  id: string;
  name: string;
  parentFolderId: string | null;
  projectPageId: string | null;
  status: FolderStatus;
  archived: boolean;
  version: number;
  createdSessionId: string | null;
  createdEventId: number | null;
  completedKind: FolderCompletionKind | null;
  completedSessionId: string | null;
  completedEventId: number | null;
  completedUserId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}


export interface FolderSnapshot { folder: FolderRow; cards: CardRow[] }
interface Projection { snapshot: FolderSnapshot | null; status: "idle" | "loading" | "ready" | "error"; error: string | null; isRefreshing: boolean }
interface SetFolderStatusInput { folderId: string; status: FolderStatus; expectedVersion: number; idempotencyKey: string; reason?: string | null }
export async function fetchFolderSnapshot(folderId: string, signal?: AbortSignal): Promise<FolderSnapshot | null> {
  const response=await fetch(`/api/folders/${encodeURIComponent(folderId)}`, {credentials:"same-origin",signal,headers:{Accept:"application/json"}});
  if(response.status===404)return null;
  if(!response.ok)throw new Error(`폴더 요청 실패 (${response.status})`);
  return response.json();
}
interface FolderState { byId: Record<string, Projection>; loadFolder(id:string, options?:{force?:boolean;signal?:AbortSignal}): Promise<FolderSnapshot|null>; setFolderStatus(input:SetFolderStatusInput):Promise<FolderSnapshot|null>; handleFolderUpdated(event:{folderId:string}):Promise<unknown>|undefined; reset():void }
export const useFolderCardStore=create<FolderState>((set,get)=>({
 byId:{},
 async loadFolder(id,options={}) {
  const previous=get().byId[id];
  if(!options.force&&previous?.status==="ready")return previous.snapshot;
  set(s=>({byId:{...s.byId,[id]:{snapshot:previous?.snapshot??null,status:previous?.snapshot?"ready":"loading",error:null,isRefreshing:Boolean(previous?.snapshot)}}}));
  try {const snapshot=await fetchFolderSnapshot(id,options.signal);if(snapshot)useCardStore.getState().putCards(snapshot.cards);set(s=>({byId:{...s.byId,[id]:{snapshot,status:"ready",error:null,isRefreshing:false}}}));return snapshot;}
  catch(error){if(error instanceof Error&&error.name==="AbortError")return get().byId[id]?.snapshot??null;set(s=>({byId:{...s.byId,[id]:{...s.byId[id],status:"error",error:String(error),isRefreshing:false}}}));throw error;}
 },
 async setFolderStatus(input){const {folderId,...body}=input;await cardRequest(`/api/folders/${encodeURIComponent(folderId)}/status`,"POST",body);return get().loadFolder(folderId,{force:true});},
 handleFolderUpdated(event){if(get().byId[event.folderId])return get().loadFolder(event.folderId,{force:true});},
 reset(){set({byId:{}});}
}));
