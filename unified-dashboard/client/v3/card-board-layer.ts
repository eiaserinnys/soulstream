import { createContext, useContext } from "react";
/** A popup or active sensor owns dismissal until its own lifecycle ends. */
export const CardBoardLayerContext=createContext<{claim():()=>void}|null>(null);
export const useCardBoardLayer=()=>useContext(CardBoardLayerContext);
