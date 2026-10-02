import { Button } from "@seosoyoung/soul-ui";
import "./folder-picker.css";

/** The FolderPicker tab contract, shared without changing its appearance. */
export function DetailTabs<T extends string>({id,label,panelId,tabs,value,disabled,onChange}: {
 id:string;label:string;panelId:string;tabs:readonly (readonly [T,string])[];value:T;disabled?:boolean;onChange(value:T):void;
}) {
 return <div className="v3-folder-picker-tabs" role="tablist" aria-label={label}>
  {tabs.map(([tab,text])=><Button key={tab} variant="ghost" role="tab" id={`${id}-${tab}`} aria-selected={value===tab}
   aria-controls={panelId} disabled={disabled} onClick={()=>onChange(tab)}>{text}</Button>)}
 </div>;
}
