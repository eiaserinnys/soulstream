import { create } from "zustand";
export const useCardNavigation = create<{
  cardId: string | null; placement: "overlay"; focus: string | null; initialSessionId: string | null;
  open(id: string, placement?: "overlay", focus?: string | null, initialSessionId?: string | null): void; close(): void;
}>((set)=>({cardId:null,placement:"overlay",focus:null,initialSessionId:null,
  open:(cardId,placement="overlay",focus=null,initialSessionId=null)=>set({cardId,placement,focus,initialSessionId}),
  close:()=>set({cardId:null,focus:null,initialSessionId:null})}));
