import { createContext, useContext, type ReactNode } from "react";
import type { ReportTimelineLine } from "@soulstream/wire-schema/persistent-report";

export type ReportTimelineAlignmentInset = "avatar" | "content";
type ReportTimelineRowRenderer = (
  line: ReportTimelineLine,
  alignmentInset: ReportTimelineAlignmentInset,
) => ReactNode;

const ReportTimelineRowContext = createContext<ReportTimelineRowRenderer | null>(null);

export function ReportTimelineRowProvider({
  render,
  children,
}: {
  render: ReportTimelineRowRenderer;
  children: ReactNode;
}) {
  return <ReportTimelineRowContext.Provider value={render}>{children}</ReportTimelineRowContext.Provider>;
}

export function useReportTimelineRow(): ReportTimelineRowRenderer | null {
  return useContext(ReportTimelineRowContext);
}
