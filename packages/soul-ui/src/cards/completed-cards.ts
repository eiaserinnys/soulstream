export type CompletedPeriod = "7" | "30" | "all" | "custom";
export type CompletedCardParams = { folderId?: string; completedFrom?: string; completedBefore?: string; q?: string; limit?: number; cursor?: string };
export const completedPeriods = [{value:"7",label:"지난 7일"},{value:"30",label:"지난 30일"},
  {value:"all",label:"전체"},{value:"custom",label:"기간 지정"}] as const;
export function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
export function completedBounds(period: CompletedPeriod, start: string, end: string, now: number) {
  if(period === "all") return {};
  if(period !== "custom") return {completedFrom:new Date(now-Number(period)*24*60*60*1000).toISOString(),completedBefore:new Date(now).toISOString()};
  const from=new Date(`${start}T00:00:00`),before=new Date(`${end}T00:00:00`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||!Number.isFinite(+from)||!Number.isFinite(+before)||localDate(from)!==start||localDate(before)!==end||from>before) return null;
  before.setDate(before.getDate()+1);
  return {completedFrom:from.toISOString(),completedBefore:before.toISOString()};
}
export function completedGridLayout(viewport: number,paperWidth: number,gap: number,inset: number) {
  const columns=Math.max(1,Math.min(3,Math.floor((viewport-2*inset+gap)/(paperWidth+gap))));
  return {columns,width:columns*paperWidth+(columns-1)*gap+2*inset};
}
