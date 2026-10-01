import { create } from "zustand";
export const useCardNavigation = create<{
  cardId: string | null; placement: "overlay"; focus: string | null;
  open(id: string, placement?: "overlay", focus?: string | null): void; close(): void;
}>((set)=>({cardId:null,placement:"overlay",focus:null,open:(cardId,placement="overlay",focus=null)=>set({cardId,placement,focus}),close:()=>set({cardId:null,focus:null})}));
