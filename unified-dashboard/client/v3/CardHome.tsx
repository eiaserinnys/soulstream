import { DashboardIconCap, type CatalogFolder } from "@seosoyoung/soul-ui";
import { History } from "lucide-react";
import { CardInbox } from "./CardInbox";
import { CardHandoff } from "./CardHandoff";

/** The home replaces the daily heading; the existing composer and shell remain. */
export function CardHome({folders,onOpenRecord}:{folders:readonly CatalogFolder[];onOpenRecord():void}) {
  return <div className="v3-planner-column v3-planner-column--daily v3-card-home" data-testid="card-home">
    <CardInbox folders={folders} initialBoard actions={<DashboardIconCap size="small" label="기록" onClick={onOpenRecord}><History className="h-4 w-4"/></DashboardIconCap>}/>
    <div className="v3-today-handoff"><CardHandoff folders={folders}/></div>
  </div>;
}
