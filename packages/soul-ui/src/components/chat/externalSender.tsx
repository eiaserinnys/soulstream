import { Link, Webhook } from 'lucide-react';
import type { CallerInfo } from '../../shared/types';

export function externalSenderDisplay(caller: CallerInfo | undefined) {
  if (caller?.source !== 'external') return null;
  const webhook = caller.transport === 'webhook';
  return {
    prefix: '외부 연동',
    name: caller.display_name || '',
    icon: webhook ? 'webhook' as const : 'link' as const,
    title: webhook ? '웹훅' : '접속 링크',
  };
}

export type ExternalSender = NonNullable<ReturnType<typeof externalSenderDisplay>>;

export function ExternalSenderCaption({ sender }: { sender: ExternalSender }) {
  const Icon = sender.icon === 'webhook' ? Webhook : Link;
  return <div className="mb-1 flex min-w-0 items-center justify-end gap-1 text-muted-foreground" aria-label={`${sender.prefix} ${sender.title}`}>
    <Icon size={14} aria-hidden="true" />
    <span className="text-xs font-medium">{sender.prefix}</span>
    {sender.name && <span className="min-w-0 truncate text-xs font-semibold">{sender.name}</span>}
  </div>;
}

export function ExternalSenderHeading({ sender }: { sender: ExternalSender }) {
  return <div className="mb-1 flex min-w-0 items-baseline justify-end gap-1.5">
    <span className="shrink-0 text-xs text-white/55">{sender.prefix}</span>
    {sender.name && <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-white/75">{sender.name}</span>}
  </div>;
}
