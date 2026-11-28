import { type CatalogFolder } from "@seosoyoung/soul-ui";
import { CardInbox } from "./CardInbox";
import { CardHandoff } from "./CardHandoff";

export function CardHome({folders}:{folders:readonly CatalogFolder[]}) {
  return <div className="v3-planner-column v3-planner-column--daily v3-card-home" data-testid="card-home">
    <CardInbox folders={folders} initialBoard/>
    <div className="v3-today-handoff"><CardHandoff folders={folders}/></div>
  </div>;
}
