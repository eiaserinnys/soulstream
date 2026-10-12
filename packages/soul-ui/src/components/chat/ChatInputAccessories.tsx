import type { ReactNode } from "react";

export function ChatInputAccessories({
  attachments,
  action,
}: {
  attachments?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex w-full min-w-0 items-center gap-2" data-slot="chat-input-accessories">
      <div className="min-w-0 flex-1" data-slot="chat-input-accessories-attachments">
        {attachments}
      </div>
      {action ? (
        <div className="ml-auto shrink-0" data-slot="chat-input-accessories-action">
          {action}
        </div>
      ) : null}
    </div>
  );
}
