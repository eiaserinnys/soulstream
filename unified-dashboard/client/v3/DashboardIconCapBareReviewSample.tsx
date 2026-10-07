import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { House, ListTodo, Paperclip } from "lucide-react";

export function DashboardIconCapBareReviewSample() {
  return (
    <div className="v3-folder-header-actions">
      <DashboardIconCap appearance="bare" label="Bare 44">
        <House className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      </DashboardIconCap>
      <DashboardIconCap appearance="bare" size="small" label="Bare 32">
        <ListTodo className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      </DashboardIconCap>
      <DashboardIconCap appearance="bare" size="small" label="Bare 비활성" disabled>
        <Paperclip className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      </DashboardIconCap>
    </div>
  );
}
