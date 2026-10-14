import { Button } from "@seosoyoung/soul-ui";
import type { PersistentTaskTooltipContent } from "./PersistentSessionTaskList";

export function PersistentTaskTooltipPanel({ content, options, sending, error, onSelect }: {
  content: PersistentTaskTooltipContent;
  options: readonly string[];
  sending: boolean;
  error: boolean;
  onSelect(option: string): void;
}) {
  return <>
    {content.title ? <p data-tooltip-field="title">{content.title}</p> : null}
    {content.now ? <p data-tooltip-field="now">{content.now}</p> : null}
    {content.ask ? <p data-tooltip-field="ask">{content.ask}</p> : null}
    {error ? <p role="alert" className="v3-card-error">답을 보내지 못했습니다</p> : null}
    {options.length > 0 ? <div className="chat-ui-actions pas-report-actions">
      {options.map(option => <Button key={option} variant="outline" disabled={sending} tabIndex={-1} onClick={() => onSelect(option)}>{option}</Button>)}
    </div> : null}
  </>;
}
