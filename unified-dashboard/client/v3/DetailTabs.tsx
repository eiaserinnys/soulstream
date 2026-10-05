import { Button } from "@seosoyoung/soul-ui";
import type { ReactNode } from "react";
import "./folder-picker.css";

/** The FolderPicker tab contract, shared without changing its appearance. */
export function DetailTabs<T extends string>({id,label,panelId,tabs,value,disabled,onChange,variant="default"}: {
 id:string;label:string;panelId:string;tabs:readonly (readonly [T,ReactNode])[];value:T;disabled?:boolean;variant?:"default"|"card";onChange(value:T):void;
}) {
 return <div className={`v3-folder-picker-tabs${variant==="card"?" v3-card-detail-tabs":""}`} role="tablist" aria-label={label}>
  {tabs.map(([tab,text])=><Button key={tab} className={variant==="card"?"v3-card-detail-tab":undefined} variant="ghost" role="tab" id={`${id}-${tab}`} aria-selected={value===tab}
   aria-controls={panelId} disabled={disabled} onClick={()=>onChange(tab)}>{text}</Button>)}
 </div>;
}
