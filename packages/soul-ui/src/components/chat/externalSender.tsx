import type { useTranslation } from "react-i18next";
import { Link, Webhook } from 'lucide-react';
import type { CallerInfo } from '@soulstream/wire-schema';

export function externalSenderDisplay(caller: CallerInfo | undefined, t: ReturnType<typeof useTranslation>["t"]) {
  if (caller?.source !== 'external') return null;
  const webhook = caller.transport === 'webhook';
  return {
    prefix: t("ui.chat.externalConnection"),
    name: caller.display_name || '',
    icon: webhook ? 'webhook' as const : 'link' as const,
    title: webhook ? t("ui.chat.webhook") : t("ui.chat.accessLink"),
  };
}

export type ExternalSender = NonNullable<ReturnType<typeof externalSenderDisplay>>;

export function ExternalSenderCaption({ sender }: { sender: ExternalSender }) {
  const Icon = sender.icon === 'webhook' ? Webhook : Link;
  return <div data-testid="external-sender-caption" className="mb-1 flex min-w-0 items-center justify-end gap-1 text-muted-foreground">
    <span className="inline-flex shrink-0" role="img" aria-label={`${sender.prefix} ${sender.title}`} title={sender.title}>
      <Icon size={14} aria-hidden="true" />
    </span>
    <span data-testid="external-sender-prefix" className="shrink-0 whitespace-nowrap text-xs font-medium">{sender.prefix}</span>
    {sender.name && <span className="min-w-0 truncate text-xs font-semibold">{sender.name}</span>}
  </div>;
}

export function ExternalSenderHeading({ sender }: { sender: ExternalSender }) {
  return <div className="mb-1 flex min-w-0 items-baseline justify-end gap-1.5">
    <span data-testid="external-sender-prefix" className="shrink-0 text-xs text-white/55">{sender.prefix}</span>
    {sender.name && <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-white/75">{sender.name}</span>}
  </div>;
}
