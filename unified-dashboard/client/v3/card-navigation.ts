import { create } from "zustand";
export const useCardNavigation = create<{
  cardId: string | null; placement: "inline" | "overlay"; focus: string | null;
  open(id: string, placement?: "inline" | "overlay", focus?: string | null): void; close(): void;
}>((set)=>({cardId:null,placement:"inline",focus:null,open:(cardId,placement="inline",focus=null)=>set({cardId,placement,focus}),close:()=>set({cardId:null,focus:null})}));
