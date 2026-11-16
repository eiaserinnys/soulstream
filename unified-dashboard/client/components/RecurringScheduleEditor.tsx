import { Button, Input } from "@seosoyoung/soul-ui";
import { inputControlClassName, inputFieldClassName } from "@seosoyoung/soul-ui/components/ui/input";

import type { RecurringScheduleDraft, RecurringScheduleMode } from "../lib/recurring-schedule";
import { SettingsField } from "./config/SettingsListDetail";

const modes: Array<{ id: RecurringScheduleMode; label: string }> = [
  { id: "once", label: "1회" },
  { id: "daily", label: "매일" },
  { id: "weekdays", label: "평일" },
  { id: "weekly", label: "매주 요일" },
  { id: "monthly", label: "매월 날짜" },
  { id: "advanced", label: "고급 cron" },
];
const weekdays = ["일", "월", "화", "수", "목", "금", "토"];

export function RecurringScheduleEditor({
  value,
  onChange,
  scheduleKind,
}: {
  value: RecurringScheduleDraft;
  onChange(value: RecurringScheduleDraft): void;
  scheduleKind?: "recurring" | "once";
}) {
  const set = (patch: Partial<RecurringScheduleDraft>) => onChange({ ...value, ...patch });
  return <div className="grid gap-3 rounded border border-border p-3" data-testid="recurring-schedule-editor">
    <SettingsField label="반복"><span className={inputControlClassName} data-slot="input-control"><select aria-label="반복 주기" className={inputFieldClassName} disabled={scheduleKind === "once"} value={value.mode} onChange={(event) => set({ mode: event.target.value as RecurringScheduleMode })}>{modes.map((mode) => <option key={mode.id} value={mode.id} disabled={mode.id === "once" && scheduleKind === "recurring"}>{mode.label}</option>)}</select></span></SettingsField>
    {value.mode === "once" ? <SettingsField label="실행 일시"><Input className="min-w-0" aria-label="실행 일시" type="datetime-local" value={value.runAtLocal} onChange={(event) => set({ runAtLocal: event.target.value })} /></SettingsField> : value.mode !== "advanced" ? <>
      <div className="grid gap-1"><span className="text-sm text-muted-foreground">실행 시각</span><div className="flex flex-wrap items-center gap-2">{value.times.map((time, index) => <div key={`${time}-${index}`} className="flex items-center gap-1"><Input className="w-auto" aria-label={`실행 시각 ${index + 1}`} type="time" value={time} onChange={(event) => set({ times: value.times.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} />{value.times.length > 1 ? <Button type="button" size="sm" variant="outline" onClick={() => set({ times: value.times.filter((_, itemIndex) => itemIndex !== index) })}>삭제</Button> : null}</div>)}<Button type="button" size="sm" variant="outline" onClick={() => set({ times: [...value.times, "12:00"] })}>시각 추가</Button></div></div>
      {value.mode === "weekly" ? <div className="grid gap-1"><span className="text-sm text-muted-foreground">요일</span><div className="flex flex-wrap gap-1">{weekdays.map((label, day) => <Button key={label} type="button" size="sm" variant={value.weekdays.includes(day) ? "default" : "outline"} onClick={() => set({ weekdays: value.weekdays.includes(day) ? value.weekdays.filter((item) => item !== day) : [...value.weekdays, day] })}>{label}</Button>)}</div></div> : null}
      {value.mode === "monthly" ? <SettingsField label="매월 날짜"><span className={inputControlClassName} data-slot="input-control"><select aria-label="매월 날짜" className={inputFieldClassName} multiple value={value.monthDays.map(String)} onChange={(event) => set({ monthDays: [...event.currentTarget.selectedOptions].map((option) => Number(option.value)) })}>{Array.from({ length: 31 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{day}일</option>)}</select></span><span className="text-xs text-muted-foreground">여러 날짜를 선택할 수 있습니다.</span></SettingsField> : null}
    </> : <details open><summary className="cursor-pointer text-sm text-muted-foreground">고급 cron 직접 편집</summary><span className={`${inputControlClassName} mt-2`} data-slot="input-control"><textarea aria-label="고급 cron" className={`${inputFieldClassName} resize-none py-2`} rows={3} value={value.advancedExpressions} onChange={(event) => set({ advancedExpressions: event.target.value })} placeholder="0 9 * * 1-5" /></span><p className="mt-1 text-xs text-muted-foreground">한 줄에 5필드 cron 하나를 입력합니다.</p></details>}
  </div>;
}
